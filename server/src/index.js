import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();
app.listen(config.port, '0.0.0.0', () => {
  console.log(`TransitOps API listening on :${config.port}/api`);
});
