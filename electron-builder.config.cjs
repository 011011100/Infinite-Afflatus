const { devDependencies } = require('./package.json');

/** Internal, unsigned artifacts only. Keep this v26 schema pinned with electron-builder. */
module.exports = {
  appId: 'com.infiniteafflatus.desktop',
  productName: 'Infinite Afflatus',
  electronVersion: devDependencies.electron,
  directories: { output: 'release', buildResources: 'src/shared/assets' },
  files: ['out/**/*', 'package.json'],
  asar: true,
  // Supplied only by the guarded packager, outside the application ASAR.
  extraResources: process.env.AFFLATUS_MEDIA_TOOLS_STAGING
    ? [
        {
          from: process.env.AFFLATUS_MEDIA_TOOLS_STAGING,
          to: 'media-tools',
          filter: ['**/*'],
        },
      ]
    : [],
  // v26 treats false from beforeBuild as externally handled node_modules.
  // The staged bundle has no runtime dependencies; do not traverse the parent workspace.
  beforeBuild: () => false,
  forceCodeSigning: false,
  publish: null,
  // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these macros.
  artifactName: '${productName}-${version}-internal-${os}-${arch}.${ext}',
  mac: {
    target: ['zip'],
    category: 'public.app-category.video',
    icon: 'src/shared/assets/app-icon.png',
    identity: null,
    hardenedRuntime: false,
    notarize: false,
  },
  win: {
    target: ['nsis'],
    icon: 'src/shared/assets/app-icon.png',
    signExecutable: false,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    runAfterFinish: false,
  },
  afterPack: async (context) => {
    const { verifyPackagedApp } = await import('./scripts/verify-package.mjs');
    const result = await verifyPackagedApp(context.appOutDir, {
      platform: context.electronPlatformName,
      productName: context.packager.appInfo.productFilename,
      arch: ['ia32', 'x64', 'armv7l', 'arm64', 'universal'][context.arch],
      requireMediaTools: !!process.env.AFFLATUS_MEDIA_TOOLS_STAGING,
      expectedMediaToolManifest: process.env.AFFLATUS_MEDIA_TOOLS_MANIFEST
        ? JSON.parse(process.env.AFFLATUS_MEDIA_TOOLS_MANIFEST)
        : undefined,
    });
    console.log(`Verified ${result.files} application files: ${result.asar}`);
    console.log(`Verified packaged app directory: ${context.appOutDir}`);
  },
};
