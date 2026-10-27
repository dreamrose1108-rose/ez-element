import { config } from './config';
App({ onLaunch() { if (config.mode === 'cloud' && config.envId) wx.cloud.init({ env: config.envId, traceUser: true }); } });
