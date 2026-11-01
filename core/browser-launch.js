export function browserLaunchOptions() {
  return {channel: 'msedge'};
}

export async function launchSystemBrowser(chromium, method, options) {
  const args=options.slice(0,-1),launchOptions=options.at(-1);
  try {
    return await chromium[method](...args,{...launchOptions,...browserLaunchOptions()});
  } catch (edgeError) {
    try {
      return await chromium[method](...args,{...launchOptions,channel:'chrome'});
    } catch (chromeError) {
      throw new AggregateError([edgeError,chromeError],'系统 Edge 和 Chrome 均无法启动');
    }
  }
}
