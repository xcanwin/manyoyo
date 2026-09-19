// 终端输入的字节拼装规则。物理键盘（xterm 的 onData）和移动端输入条共用同一套
// 规则，抽出来是为了能单测——这几条规则错一个字节，用户那边就是"回车变删除"
// 这种说不清的怪现象

// 单字符输入按当前修饰键状态转换：ctrl 走控制字符（Ctrl+A = 0x01），
// alt 走 ESC 前缀。多字符输入（粘贴、输入法整句上屏）原样返回
export function applyModifiers(data: string, ctrl: boolean, alt: boolean): string {
  if (data.length !== 1) return data
  if (ctrl) {
    const code = data.charCodeAt(0)
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      return String.fromCharCode(code & 0x1f)
    }
    return data
  }
  if (alt) return "\x1b" + data
  return data
}

// 移动端输入条按"发送"时真正写进终端的内容：
// - 单字符 + 修饰键：一个控制字符，不补回车（ctrl+c 不该变成 ctrl+c 再回车）
// - 空输入：等价于敲一次回车，用来确认 TUI 里的各种提示
// - 其余：内容 + 回车
export function buildMobileSubmitPayload(
  value: string,
  ctrl: boolean,
  alt: boolean
): string {
  if (value.length === 1 && (ctrl || alt)) {
    return applyModifiers(value, ctrl, alt)
  }
  return value ? `${value}\r` : "\r"
}
