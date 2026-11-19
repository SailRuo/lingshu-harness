import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import { registerArcoComponents } from './plugins/arco.js';
import { initApiConfig } from './utils/apiConfig';
import '@arco-design/web-vue/dist/arco.css';
import 'material-symbols/outlined.css';
import './assets/styles/base.css';

async function bootstrap() {
  const app = createApp(App);
  const pinia = createPinia();

  app.use(pinia);
  await initApiConfig();
  registerArcoComponents(app);
  app.use(router);

  app.mount('#app');
}

void bootstrap();
