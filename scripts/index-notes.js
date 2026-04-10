// scripts/index-notes.js
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;
const INDEX_NAME = process.env.VECTORIZE_INDEX || "yunchu-notes";

// 清洗 Obsidian 特有语法的函数
function cleanObsidianMarkdown(text) {
  return text
    .replace(/^---[\s\S]*?---/m, '') // 移除开头的 YAML Frontmatter 属性
    .replace(/!\[\[.*?\]\]/g, '')    // 移除图片引用
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2') // [[链接|别名]] -> 别名
    .replace(/\[\[([^\]]+)\]\]/g, '$1')            // [[链接]] -> 链接名
    .replace(/[#*`>]/g, '')          // 移除基础 Markdown 符号，保留纯文本语义
    .replace(/\n+/g, ' ')            // 把多行合并，防止切块时断裂
    .trim();
}

// 文本切块函数 (按大概的字符长度切，防止超过大模型处理上限)
function chunkText(text, maxChar = 500) {
  const chunks = [];
  let current = 0;
  while (current < text.length) {
    chunks.push(text.slice(current, current + maxChar));
    current += maxChar;
  }
  return chunks;
}

// 调用 Cloudflare Workers AI 获取向量 (Embedding)
async function getEmbeddings(textArray) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/@cf/baai/bge-base-en-v1.5`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: textArray })
  });
  if (!res.ok) throw new Error(`AI 请求失败: ${await res.text()}`);
  const data = await res.json();
  return data.result.data; // 返回向量数组
}

// 写入 Cloudflare Vectorize 数据库
async function insertIntoVectorize(vectors) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/insert`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/x-ndjson' },
    body: vectors.map(v => JSON.stringify(v)).join('\n') // Vectorize API 要求 ndjson 格式
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

    // 获取向量
    const embeddings = await getEmbeddings(chunks);
    
    // 组装向量数据库所需的数据格式
    const vectors = chunks.map((chunkText, index) => ({
      id: crypto.randomUUID(), // 生成唯一 ID
      values: embeddings[index], // 768 维的向量数据
      metadata: {
        source: fileName,
        text: chunkText // 把原文本也存进去，方便 AI 提取答案
      }
    }));

    // 写入数据库
    await insertIntoVectorize(vectors);
    console.log(`✅ 文件 ${file} 的 ${vectors.length} 个数据块已成功泵入向量库！`);
  }
}

main().catch(console.error);
