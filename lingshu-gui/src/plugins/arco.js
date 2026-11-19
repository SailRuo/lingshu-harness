import ArcoVueModule from '@arco-design/web-vue';

const arcoPlugin = ArcoVueModule.default ?? ArcoVueModule;

export const arcoPluginName = 'ArcoVue';

export function registerArcoComponents(app) {
  app.use(arcoPlugin);
}
