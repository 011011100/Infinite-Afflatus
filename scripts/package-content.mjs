import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { parseAst } from 'vite';

export const APP_NAME = 'Infinite Afflatus';
export const APP_ID = 'com.infiniteafflatus.desktop';
const runtimeImports = new Set([
  'electron',
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

/** Only generated runtime code and the existing application icon enter the app. */
export function allowedApplicationFile(path) {
  return (
    path === 'package.json' ||
    /^out\/main\/(?:index\.js|chunks\/[\w.-]+\.(?:js|png))$/.test(path) ||
    path === 'out/preload/index.cjs' ||
    path === 'out/renderer/index.html' ||
    path === 'out/renderer/app-icon.png' ||
    /^out\/renderer\/assets\/[\w.-]+\.(?:js|css|png|svg|webp|jpe?g|woff2?)$/.test(
      path,
    )
  );
}

export function checkApplicationFiles(files, read) {
  for (const file of files) {
    if (
      !allowedApplicationFile(file) ||
      file.split('/').some((part) => part.startsWith('.'))
    )
      throw new Error(`Unexpected packaged file: ${file}`);
  }
  for (const file of [
    'package.json',
    'out/main/index.js',
    'out/preload/index.cjs',
    'out/renderer/index.html',
    'out/renderer/app-icon.png',
  ]) {
    if (!files.includes(file))
      throw new Error(`Missing packaged file: ${file}`);
  }
  const metadata = JSON.parse(read('package.json'));
  if (
    metadata.name !== 'infinite-afflatus' ||
    metadata.productName !== APP_NAME ||
    metadata.main !== './out/main/index.js' ||
    metadata.type !== 'module' ||
    metadata.dependencies ||
    metadata.devDependencies ||
    metadata.scripts
  )
    throw new Error(
      'Packaged application metadata must be minimal and preserve its identity',
    );
  for (const file of files.filter((file) =>
    /^out\/(?:main|preload)\/.*\.(?:js|cjs)$/.test(file),
  )) {
    const code = parseAst(read(file));
    const imports = [];
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (
        [
          'ImportDeclaration',
          'ExportNamedDeclaration',
          'ExportAllDeclaration',
        ].includes(node.type)
      ) {
        if (node.source) imports.push(node.source.value);
      } else if (
        node.type === 'ImportExpression' ||
        (node.type === 'CallExpression' &&
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require')
      ) {
        const argument =
          node.type === 'ImportExpression' ? node.source : node.arguments[0];
        if (argument?.type !== 'Literal' || typeof argument.value !== 'string')
          throw new Error(
            `Dynamic runtime dependency cannot be audited: ${file}`,
          );
        imports.push(argument.value);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    }
    visit(code);
    for (const specifier of imports) {
      if (runtimeImports.has(specifier)) continue;
      if (
        !specifier.startsWith('.') ||
        !files.includes(
          posix.normalize(posix.join(posix.dirname(file), specifier)),
        )
      )
        throw new Error(
          `Unbundled runtime dependency in ${file}: ${specifier}`,
        );
    }
  }
  const icons = [
    ...read('out/main/index.js').matchAll(/chunks\/app-icon-[\w-]+\.png/g),
  ];
  if (
    !icons.length ||
    icons.some(([icon]) => !files.includes(`out/main/${icon}`))
  )
    throw new Error('Packaged main process is missing its application icon');
  const html = read('out/renderer/index.html');
  const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  if (
    !refs.some((ref) => ref.endsWith('.js')) ||
    !refs.some((ref) => ref.endsWith('.css'))
  )
    throw new Error(
      'Packaged renderer is missing its JavaScript or stylesheet',
    );
  for (const ref of refs) {
    if (
      !ref.startsWith('./') ||
      !files.includes(posix.normalize(`out/renderer/${ref}`))
    )
      throw new Error(
        `Packaged renderer has a missing or non-local resource: ${ref}`,
      );
  }
}

export async function stageApplication(root, destination) {
  const metadata = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  );
  const files = ['package.json'];
  const contents = new Map();
  const manifest = JSON.stringify(
    {
      name: metadata.name,
      productName: metadata.productName,
      version: metadata.version,
      description: metadata.description,
      private: true,
      type: metadata.type,
      main: metadata.main,
    },
    null,
    2,
  );
  contents.set('package.json', manifest);
  async function visit(relative) {
    for (const entry of await readdir(join(root, relative), {
      withFileTypes: true,
    })) {
      const file = `${relative}/${entry.name}`;
      const info = await lstat(join(root, file));
      if (info.isSymbolicLink())
        throw new Error(
          `Build output must not contain symbolic links: ${file}`,
        );
      if (info.isDirectory()) await visit(file);
      else if (info.isFile()) {
        files.push(file);
        if (/\.(?:js|cjs|html)$/.test(file))
          contents.set(file, await readFile(join(root, file), 'utf8'));
      } else throw new Error(`Unsupported build output: ${file}`);
    }
  }
  if ((await lstat(join(root, 'out'))).isSymbolicLink())
    throw new Error('Build output must not be a symbolic link');
  await visit('out');
  checkApplicationFiles(files, (file) => contents.get(file));
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'package.json'), `${manifest}\n`, {
    flag: 'wx',
  });
  for (const file of files.filter((file) => file !== 'package.json')) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, file), target);
  }
  return files;
}
