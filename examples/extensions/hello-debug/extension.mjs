export const actions = {
  async diagnose(params, context) {
    return {
      ok: true,
      extensionApiVersion: context.apiVersion,
      appVersion: context.appVersion,
      received: params
    };
  }
};
