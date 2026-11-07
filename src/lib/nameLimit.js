/**
 * 记忆槽名称长度限制，必须和固件对齐。
 *
 * 固件 Common.h：MEMORY_NAME_LEN = 25，即最多 24 字节 UTF-8（8 个汉字，
 * 或 24 个英文字符），Storage.cpp 会拒绝超长记录。
 *
 * 截断必须按「整个字符」走：直接 slice 会切断 3 字节的汉字，剩下的半个字符
 * 变成非法 UTF-8，屏幕和 App 上就显示成方块/问号。
 */
const NAME_MAX_BYTES = 24;
const encoder = new TextEncoder();

export function clampName(value) {
  const text = value === undefined || value === null ? '' : String(value);
  let out = '';
  let used = 0;

  for (const ch of Array.from(text)) {
    const size = encoder.encode(ch).length;
    if (used + size > NAME_MAX_BYTES) break;
    out += ch;
    used += size;
  }

  return out;
}

export { NAME_MAX_BYTES };
