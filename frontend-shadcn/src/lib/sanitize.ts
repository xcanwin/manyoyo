// 双向控制符（RTLO 等）/ 零宽字符可以让文件名视觉上和真实字节完全不一致
// （例如 "cod" + U+202E + "exe.txt" 会被浏览器渲染成 "codtxt.exe"），
// 展示前统一替换成可见的 \uXXXX 记法，破坏其排版效果并让人一眼看出异常。
// 范围：U+200B-U+200F（零宽字符/LRM/RLM）、U+202A-U+202E（嵌入/覆盖方向控制符）、
// U+2060-U+2069（零宽连接符/方向隔离符）、U+FEFF（BOM/零宽不换行空格）、U+061C（阿拉伯字母标记）。
// 用数值码点拼接构造正则，避免源码里直接出现不可见字符本身。
const SUSPICIOUS_UNICODE_RANGES: Array<[number, number]> = [
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
  [0x061c, 0x061c],
]

const SUSPICIOUS_UNICODE_PATTERN = new RegExp(
  "[" +
    SUSPICIOUS_UNICODE_RANGES.map(
      ([start, end]) => String.fromCodePoint(start) + "-" + String.fromCodePoint(end)
    ).join("") +
    "]",
  "g"
)

export function sanitizeDisplayText(value: string | null | undefined): string {
  return String(value == null ? "" : value).replace(SUSPICIOUS_UNICODE_PATTERN, (ch) =>
    "\\u" + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")
  )
}
