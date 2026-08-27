import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.crypton.app',
  appName: 'CRYPTON',
  webDir: 'www',
  android: {
    // Sin contenido mixto: la app habla con la API por HTTPS y no debe poder
    // caer a HTTP en ningun caso — por ahi viajan tokens de sesion.
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: false,
      backgroundColor: '#06080d',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#06080d',
    },
    Keyboard: {
      resizeOnFullScreen: true,
    },
  },
};

export default config;
