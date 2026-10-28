import fs from 'node:fs';

export function browserLaunchOptions(executablePath = process.env.LINGTU_BROWSER_PATH) {
  if (!executablePath) return { channel: 'chrome' };
  // MSIX can redirect AppData reads while CreateProcess still needs the physical path.
  // Resolve at each launch so existing registries and direct CLI callers also work.
  try {
    const resolved = fs.realpathSync.native(executablePath);
    if (!fs.statSync(resolved).isFile()) throw new Error('不是浏览器程序文件');
    return { executablePath: resolved };
  } catch (cause) {
    throw new Error('配套浏览器文件不可用，请在工作台的扩展设置中检查或重新安装浏览器组件', { cause });
  }
}
