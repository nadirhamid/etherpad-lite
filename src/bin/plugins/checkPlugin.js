'use strict';

/*
 * Usage -- see README.md
 *
 * Normal usage:                node src/bin/plugins/checkPlugin.js ep_whatever
 * Auto fix the things it can:  node src/bin/plugins/checkPlugin.js ep_whatever autofix
 * Auto fix and commit:         node src/bin/plugins/checkPlugin.js ep_whatever autocommit
 * Auto fix, commit, push and publish to npm (highly dangerous):
 *                              node src/bin/plugins/checkPlugin.js ep_whatever autopush
 */

// As of v14, Node.js does not exit when there is an unhandled Promise rejection. Convert an
// unhandled rejection into an uncaught exception, which does cause Node.js to exit.
process.on('unhandledRejection', (err) => { throw err; });

const assert = require('assert').strict;
const fs = require('fs');
const fsp = fs.promises;
const childProcess = require('child_process');
const path = require('path');

// get plugin name & path from user input
const pluginName = process.argv[2];

if (!pluginName) throw new Error('no plugin name specified');

const pluginPath = `node_modules/${pluginName}`;

console.log(`Checking the plugin: ${pluginName}`);

const optArgs = process.argv.slice(3);
const autoPush = optArgs.includes('autopush');
const autoCommit = autoPush || optArgs.includes('autocommit');
const autoFix = autoCommit || optArgs.includes('autofix');

const execSync = (cmd, opts = {}) => (childProcess.execSync(cmd, {
  cwd: `${pluginPath}/`,
  ...opts,
}) || '').toString().replace(/\n+$/, '');

const writePackageJson = async (obj) => {
  let s = JSON.stringify(obj, null, 2);
  if (s.length && s.slice(s.length - 1) !== '\n') s += '\n';
  return await fsp.writeFile(`${pluginPath}/package.json`, s);
};

const checkEntries = (got, want) => {
  let changed = false;
  for (const [key, val] of Object.entries(want)) {
    try {
      assert.deepEqual(got[key], val);
    } catch (err) {
      console.warn(`${key} possibly outdated.`);
      console.warn(err.message);
      if (autoFix) {
        got[key] = val;
        changed = true;
      }
    }
  }
  return changed;
};

const updateDeps = async (parsedPackageJson, key, wantDeps) => {
  const {[key]: deps = {}} = parsedPackageJson;
  let changed = false;
  for (const [pkg, verInfo] of Object.entries(wantDeps)) {
    const {ver, overwrite = true} = typeof verInfo === 'string' ? {ver: verInfo} : verInfo;
    if (deps[pkg] === ver) continue;
    if (deps[pkg] == null) {
      console.warn(`Missing dependency in ${key}: '${pkg}': '${ver}'`);
    } else {
      if (!overwrite) continue;
      console.warn(`Dependency mismatch in ${key}: '${pkg}': '${ver}' (current: ${deps[pkg]})`);
    }
    if (autoFix) {
      deps[pkg] = ver;
      changed = true;
    }
  }
  if (changed) {
    parsedPackageJson[key] = deps;
    await writePackageJson(parsedPackageJson);
  }
};

const prepareRepo = () => {
  const modified = execSync('git diff-files --name-status');
  if (modified !== '') throw new Error(`working directory has modifications:\n${modified}`);
  const untracked = execSync('git ls-files -o --exclude-standard');
  if (untracked !== '') throw new Error(`working directory has untracked files:\n${untracked}`);
  const indexStatus = execSync('git diff-index --cached --name-status HEAD');
  if (indexStatus !== '') throw new Error(`uncommitted staged changes to files:\n${indexStatus}`);
  let br;
  if (autoCommit) {
    br = execSync('git symbolic-ref HEAD');
    if (!br.startsWith('refs/heads/')) throw new Error('detached HEAD');
    br = br.replace(/^refs\/heads\//, '');
    execSync('git rev-parse --verify -q HEAD^0 || ' +
             `{ echo "Error: no commits on ${br}" >&2; exit 1; }`);
    execSync('git config --get user.name');
    execSync('git config --get user.email');
  }
  if (autoPush) {
    if (!['master', 'main'].includes(br)) throw new Error('master/main not checked out');
    execSync('git rev-parse --verify @{u}');
    execSync('git pull --ff-only', {stdio: 'inherit'});
    if (execSync('git rev-list @{u}...') !== '') throw new Error('repo contains unpushed commits');
  }
};

const checkFile = async (srcFn, dstFn) => {
  const outFn = path.join(pluginPath, dstFn);
  const wantContents = await fsp.readFile(srcFn, {encoding: 'utf8'});
  let gotContents = null;
  try {
    gotContents = await fsp.readFile(outFn, {encoding: 'utf8'});
  } catch (err) { /* treat as if the file doesn't exist */ }
  try {
    assert.equal(gotContents, wantContents);
  } catch (err) {
    console.warn(`File ${dstFn} is out of date`);
    console.warn(err.message);
    if (autoFix) {
      await fsp.mkdir(path.dirname(outFn), {recursive: true});
      await fsp.writeFile(outFn, wantContents);
    }
  }
};

if (autoPush) {
  console.warn('Auto push is enabled, I hope you know what you are doing...');
}

(async () => {
  const files = await fsp.readdir(pluginPath);

  // some files we need to know the actual file name.  Not compulsory but might help in the future.
  const readMeFileName = files.filter((f) => f === 'README' || f === 'README.md')[0];

  if (!files.includes('.git')) throw new Error('No .git folder, aborting');
  prepareRepo();

  const workflows = ['backend-tests.yml', 'frontend-tests.yml', 'npmpublish.yml'];
  await Promise.all(workflows.map(async (fn) => {
    await checkFile(`src/bin/plugins/lib/${fn}`, `.github/workflows/${fn}`);
  }));

  if (!files.includes('package.json')) {
    console.warn('no package.json, please create');
  } else {
    const packageJSON =
        await fsp.readFile(`${pluginPath}/package.json`, {encoding: 'utf8', flag: 'r'});
    const parsedPackageJSON = JSON.parse(packageJSON);

    await updateDeps(parsedPackageJSON, 'devDependencies', {
      'eslint': '^7.32.0',
      'eslint-config-etherpad': '^2.0.2',
      'eslint-plugin-cypress': '^2.12.1',
      'eslint-plugin-eslint-comments': '^3.2.0',
      'eslint-plugin-mocha': '^9.0.0',
      'eslint-plugin-node': '^11.1.0',
      'eslint-plugin-prefer-arrow': '^1.2.3',
      'eslint-plugin-promise': '^5.1.1',
      'eslint-plugin-you-dont-need-lodash-underscore': '^6.12.0',
    });

    await updateDeps(parsedPackageJSON, 'peerDependencies', {
      // Some plugins require a newer version of Etherpad so don't overwrite if already set.
      'ep_etherpad-lite': {ver: '>=1.8.6', overwrite: false},
    });

    await updateDeps(parsedPackageJSON, 'engines', {
      node: '>=12.13.0',
    });

    if (parsedPackageJSON.eslintConfig == null) parsedPackageJSON.eslintConfig = {};
    if (checkEntries(parsedPackageJSON.eslintConfig, {
      root: true,
      extends: 'etherpad/plugin',
    })) await writePackageJson(parsedPackageJSON);

    if (checkEntries(parsedPackageJSON, {
      funding: {
        type: 'individual',
        url: 'https://etherpad.org/',
      },
    })) await writePackageJson(parsedPackageJSON);

    if (parsedPackageJSON.scripts == null) parsedPackageJSON.scripts = {};
    if (checkEntries(parsedPackageJSON.scripts, {
      'lint': 'eslint .',
      'lint:fix': 'eslint --fix .',
    })) await writePackageJson(parsedPackageJSON);
  }

  if (!files.includes('package-lock.json')) {
    console.warn('package-lock.json not found');
    if (!autoFix) {
      console.warn('Run npm install in the plugin folder and commit the package-lock.json file.');
    }
  }

  const fillTemplate = async (templateFilename, outputFilename) => {
    const contents = (await fsp.readFile(templateFilename, 'utf8'))
        .replace(/\[name of copyright owner\]/g, execSync('git config user.name'))
        .replace(/\[plugin_name\]/g, pluginName)
        .replace(/\[yyyy\]/g, new Date().getFullYear());
    await fsp.writeFile(outputFilename, contents);
  };

  if (!readMeFileName) {
    console.warn('README.md file not found, please create');
    if (autoFix) {
      console.log('Autofixing missing README.md file');
      console.log('please edit the README.md file further to include plugin specific details.');
      await fillTemplate('src/bin/plugins/lib/README.md', `${pluginPath}/README.md`);
    }
  }

  if (!files.includes('CONTRIBUTING') && !files.includes('CONTRIBUTING.md')) {
    console.warn('CONTRIBUTING.md file not found, please create');
    if (autoFix) {
      console.log('Autofixing missing CONTRIBUTING.md file, please edit the CONTRIBUTING.md ' +
                  'file further to include plugin specific details.');
      await fillTemplate('src/bin/plugins/lib/CONTRIBUTING.md', `${pluginPath}/CONTRIBUTING.md`);
    }
  }


  if (readMeFileName) {
    let readme =
        await fsp.readFile(`${pluginPath}/${readMeFileName}`, {encoding: 'utf8', flag: 'r'});
    if (!readme.toLowerCase().includes('license')) {
      console.warn('No license section in README');
      if (autoFix) {
        console.warn('Please add License section to README manually.');
      }
    }
    // eslint-disable-next-line max-len
    const publishBadge = `![Publish Status](https://github.com/ether/${pluginName}/workflows/Node.js%20Package/badge.svg)`;
    // eslint-disable-next-line max-len
    const testBadge = `![Backend Tests Status](https://github.com/ether/${pluginName}/workflows/Backend%20tests/badge.svg)`;
    if (readme.toLowerCase().includes('travis')) {
      console.warn('Remove Travis badges');
    }
    if (!readme.includes('workflows/Node.js%20Package/badge.svg')) {
      console.warn('No Github workflow badge detected');
      if (autoFix) {
        readme = `${publishBadge} ${testBadge}\n\n${readme}`;
        // write readme to file system
        await fsp.writeFile(`${pluginPath}/${readMeFileName}`, readme);
        console.log('Wrote Github workflow badges to README');
      }
    }
  }

  if (!files.includes('LICENSE') && !files.includes('LICENSE.md')) {
    console.warn('LICENSE file not found, please create');
    if (autoFix) {
      console.log('Autofixing missing LICENSE file (Apache 2.0).');
      await fsp.copyFile('src/bin/plugins/lib/LICENSE', `${pluginPath}/LICENSE`);
    }
  }

  if (!files.includes('.gitignore')) {
    console.warn('.gitignore file not found, please create.  .gitignore files are useful to ' +
                 "ensure files aren't incorrectly commited to a repository.");
    if (autoFix) {
      console.log('Autofixing missing .gitignore file');
      const gitignore =
          await fsp.readFile('src/bin/plugins/lib/gitignore', {encoding: 'utf8', flag: 'r'});
      await fsp.writeFile(`${pluginPath}/.gitignore`, gitignore);
    }
  } else {
    let gitignore =
        await fsp.readFile(`${pluginPath}/.gitignore`, {encoding: 'utf8', flag: 'r'});
    if (!gitignore.includes('node_modules/')) {
      console.warn('node_modules/ missing from .gitignore');
      if (autoFix) {
        gitignore += 'node_modules/';
        await fsp.writeFile(`${pluginPath}/.gitignore`, gitignore);
      }
    }
  }

  // if we include templates but don't have translations...
  if (files.includes('templates') && !files.includes('locales')) {
    console.warn('Translations not found, please create.  ' +
                 'Translation files help with Etherpad accessibility.');
  }


  if (files.includes('.ep_initialized')) {
    console.warn(
        '.ep_initialized found, please remove.  .ep_initialized should never be commited to git ' +
        'and should only exist once the plugin has been executed one time.');
    if (autoFix) {
      console.log('Autofixing incorrectly existing .ep_initialized file');
      await fsp.unlink(`${pluginPath}/.ep_initialized`);
    }
  }

  if (files.includes('npm-debug.log')) {
    console.warn('npm-debug.log found, please remove.  npm-debug.log should never be commited to ' +
                 'your repository.');
    if (autoFix) {
      console.log('Autofixing incorrectly existing npm-debug.log file');
      await fsp.unlink(`${pluginPath}/npm-debug.log`);
    }
  }

  if (files.includes('static')) {
    const staticFiles = await fsp.readdir(`${pluginPath}/static`);
    if (!staticFiles.includes('tests')) {
      console.warn('Test files not found, please create tests.  https://github.com/ether/etherpad-lite/wiki/Creating-a-plugin#writing-and-running-front-end-tests-for-your-plugin');
    }
  } else {
    console.warn('Test files not found, please create tests.  https://github.com/ether/etherpad-lite/wiki/Creating-a-plugin#writing-and-running-front-end-tests-for-your-plugin');
  }

  // Install dependencies so we can run ESLint. This should also create or update package-lock.json
  // if autoFix is enabled.
  const npmInstall = `npm install${autoFix ? '' : ' --no-package-lock'}`;
  execSync(npmInstall, {stdio: 'inherit'});
  // The ep_etherpad-lite peer dep must be installed last otherwise `npm install` will nuke it. An
  // absolute path to etherpad-lite/src is used here so that pluginPath can be a symlink.
  execSync(
      `${npmInstall} --no-save ep_etherpad-lite@file:${__dirname}/../../`, {stdio: 'inherit'});
  // linting begins
  try {
    console.log('Linting...');
    const lintCmd = autoFix ? 'npx eslint --fix .' : 'npx eslint';
    execSync(lintCmd, {stdio: 'inherit'});
  } catch (e) {
    // it is gonna throw an error anyway
    console.log('Manual linting probably required, check with: npm run lint');
  }
  // linting ends.

  if (autoFix) {
    const unchanged = JSON.parse(execSync(
        'untracked=$(git ls-files -o --exclude-standard) || exit 1; ' +
        'git diff-files --quiet && [ -z "$untracked" ] && echo true || echo false'));
    if (!unchanged) {
      // Display a diff of changes. Git doesn't diff untracked files, so they must be added to the
      // index. Use a temporary index file to avoid modifying Git's default index file.
      execSync('git read-tree HEAD; git add -A && git diff-index -p --cached HEAD && echo ""', {
        env: {...process.env, GIT_INDEX_FILE: '.git/checkPlugin.index'},
        stdio: 'inherit',
      });
      await fsp.unlink(`${pluginPath}/.git/checkPlugin.index`);

      const commitCmd = [
        'git add -A',
        'git commit -m "autofixes from Etherpad checkPlugin.js"',
      ].join(' && ');
      if (autoCommit) {
        console.log('Committing changes...');
        execSync(commitCmd, {stdio: 'inherit'});
      } else {
        console.log('Fixes applied. Check the above git diff then run the following command:');
        console.log(`(cd node_modules/${pluginName} && ${commitCmd})`);
      }
      const pushCmd = 'git push';
      if (autoPush) {
        console.log('Pushing new commit...');
        execSync(pushCmd, {stdio: 'inherit'});
      } else {
        console.log('Changes committed. To push, run the following command:');
        console.log(`(cd node_modules/${pluginName} && ${pushCmd})`);
      }
    } else {
      console.log('No changes.');
    }
  }

  console.log('Finished');
})();
