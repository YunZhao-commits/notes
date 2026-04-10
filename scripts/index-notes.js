import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;
const INDEX_NAME = process.env.VECTORIZE_INDEX || "yunchu-notes";

// 清洗 Obsidian 特有语法的函数
function cleanObsidianMarkdown(text) {
  return text
    .replace(/^---[\s\S]*?---/m, '') 
    .replace(/!\[\[.*?\]\]/g, '')    
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2') 
    .replace(/\[\[([^\]]+)\]\]/g, '$1')            
    .replace(/[#*`>]/g, '')          
    .replace(/\n+/g, ' ')            
    .trim();
}

// ⚡ CTO 优化 1：带重叠 (Overlap) 的滑动窗口切块，消除语义断裂
function chunkText(text, chunkSize = 500, overlap = 100) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + chunkSize));
    // 每次不跳一整块，而是退回 overlap 的长度，形成重叠
    start += (chunkSize - overlap); 
  }
  return chunks;
}

// 调用 Cloudflare Workers AI 获取向量
async function getEmbeddings(textArray) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/@cf/baai/bge-base-en-v1.5`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: textArray })
  });
  if (!res.ok) throw new Error(`AI 请求失败: ${await res.text()}`);
  const data = await res.json();
  return data.result.data; 
}

// 写入 Cloudflare Vectorize 数据库
async function insertIntoVectorize(vectors) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/insert`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/x-ndjson' },
    body: vectors.map(v => JSON.stringify(v)).join('\n') 
  });
  if (!res.ok) throw new Error(`插入 Vectorize 失败: ${await res.text()}`);
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0 || (files.length === 1 && files[0] === '')) {
    console.log("没有检测到更改的 Markdown 文件，跳过执行。");
    return;
  }

  console.log(`检测到 ${files.length} 个文件变更，准备处理...`);
  
  for (const file of files) {
    if (!file.endsWith('.md') || !fs.existsSync(file)) continue;
    
    console.log(`正在处理: ${file}`);
    const rawContent = fs.readFileSync(file, 'utf-8');
    const cleanText = cleanObsidianMarkdown(rawContent);
    const chunks = chunkText(cleanText);
    const fileName = path.basename(file, '.md');

    if (chunks.length === 0) continue;

    const embeddings = await getEmbeddings(chunks);
    
    const vectors = chunks.map((chunkText, index) => {
      // ⚡ CTO 优化 2：计算确定性的 Hash ID，实现精准覆盖，防止旧数据残留污染
      const hashId = crypto.createHash('md5').update(`${fileName}-chunk-${index}`).digest('hex');
      
      return {
        id: hashId, 
        values: embeddings[index], 
        metadata: {
          source: fileName,
          chunk_index: index,
          text: chunkText 
        }
      };
    });

    await insertIntoVectorize(vectors);
    console.log(`✅ 文件 ${file} 的 ${vectors.length} 个数据块 (带Overlap) 已成功泵入并覆盖向量库！`);
  }
}

main().catch(console.error);
