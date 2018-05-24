/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {
  JsonArray,
  JsonObject,
  JsonParseMode,
  Path,
  join,
  logging,
  normalize,
  parseJson,
  parseJsonAst,
  tags,
} from '@angular-devkit/core';
import {
  Rule,
  SchematicContext,
  SchematicsException,
  Tree,
  chain,
} from '@angular-devkit/schematics';
import { NodePackageInstallTask } from '@angular-devkit/schematics/tasks';
import { AppConfig, CliConfig } from '../../utility/config';
import { latestVersions } from '../../utility/latest-versions';
import {
  appendPropertyInAstObject,
  appendValueInAstArray,
  findPropertyInAstObject,
} from './json-utils';

const defaults = {
  appRoot: 'src',
  index: 'index.html',
  main: 'main.ts',
  polyfills: 'polyfills.ts',
  tsConfig: 'tsconfig.app.json',
  test: 'test.ts',
  outDir: 'dist/',
  karma: 'karma.conf.js',
  protractor: 'protractor.conf.js',
  testTsConfig: 'tsconfig.spec.json',
  serverOutDir: 'dist-server',
  serverMain: 'main.server.ts',
  serverTsConfig: 'tsconfig.server.json',
};

function getConfigPath(tree: Tree): Path {
  let possiblePath = normalize('.angular-cli.json');
  if (tree.exists(possiblePath)) {
    return possiblePath;
  }
  possiblePath = normalize('angular-cli.json');
  if (tree.exists(possiblePath)) {
    return possiblePath;
  }

  throw new SchematicsException('Could not find configuration file');
}

function migrateKarmaConfiguration(config: CliConfig): Rule {
  return (host: Tree, context: SchematicContext) => {
    context.logger.info(`Updating karma configuration`);
    try {
      const karmaPath = config && config.test && config.test.karma && config.test.karma.config
        ? config.test.karma.config
        : defaults.karma;
      const buffer = host.read(karmaPath);
      if (buffer !== null) {
        let content = buffer.toString();
        // Replace the 1.0 files and preprocessor entries, with and without comma at the end.
        // If these remain, they will cause the `ng test` to fail.
        content = content.replace(`{ pattern: './src/test.ts', watched: false },`, '');
        content = content.replace(`{ pattern: './src/test.ts', watched: false }`, '');
        content = content.replace(`'./src/test.ts': ['@angular/cli'],`, '');
        content = content.replace(`'./src/test.ts': ['@angular/cli']`, '');
        // Replace 1.x plugin names.
        content = content.replace(/@angular\/cli/g, '@angular-devkit/build-angular');
        // Replace code coverage output path.
        content = content.replace('reports',
          `dir: require('path').join(__dirname, 'coverage'), reports`);
        host.overwrite(karmaPath, content);
      }
    } catch (e) { }

    return host;
  };
}

function migrateConfiguration(oldConfig: CliConfig, logger: logging.LoggerApi): Rule {
  return (host: Tree, context: SchematicContext) => {
    const oldConfigPath = getConfigPath(host);
    const configPath = normalize('angular.json');
    context.logger.info(`Updating configuration`);
    const config: JsonObject = {
      '$schema': './node_modules/@angular/cli/lib/config/schema.json',
      version: 1,
      newProjectRoot: 'projects',
      projects: extractProjectsConfig(oldConfig, host, logger),
    };
    const defaultProject = extractDefaultProject(oldConfig);
    if (defaultProject !== null) {
      config.defaultProject = defaultProject;
    }
    const cliConfig = extractCliConfig(oldConfig);
    if (cliConfig !== null) {
      config.cli = cliConfig;
    }
    const schematicsConfig = extractSchematicsConfig(oldConfig);
    if (schematicsConfig !== null) {
      config.schematics = schematicsConfig;
    }
    const architectConfig = extractArchitectConfig(oldConfig);
    if (architectConfig !== null) {
      config.architect = architectConfig;
    }

    context.logger.info(`Removing old config file (${oldConfigPath})`);
    host.delete(oldConfigPath);
    context.logger.info(`Writing config file (${configPath})`);
    host.create(configPath, JSON.stringify(config, null, 2));

    return host;
  };
}

function extractCliConfig(config: CliConfig): JsonObject | null {
  const newConfig: JsonObject = {};
  if (config.packageManager && config.packageManager !== 'default') {
    newConfig['packageManager'] = config.packageManager;
  }
  if (config.warnings) {
    if (config.warnings.versionMismatch !== undefined) {
      newConfig.warnings = {
        ...((newConfig.warnings as JsonObject | null) || {}),
        ...{ versionMismatch: config.warnings.versionMismatch },
      };
    }
    if (config.warnings.typescriptMismatch !== undefined) {
      newConfig.warnings = {
        ...((newConfig.warnings as JsonObject | null) || {}),
        ...{ typescriptMismatch: config.warnings.typescriptMismatch },
      };
    }
  }

  return Object.getOwnPropertyNames(newConfig).length == 0 ? null : newConfig;
}

function extractSchematicsConfig(config: CliConfig): JsonObject | null {
  let collectionName = '@schematics/angular';
  if (!config || !config.defaults) {
    return null;
  }
  // const configDefaults = config.defaults;
  if (config.defaults && config.defaults.schematics && config.defaults.schematics.collection) {
    collectionName = config.defaults.schematics.collection;
  }

  /**
   * For each schematic
   *  - get the config
   *  - filter one's without config
   *  - combine them into an object
   */
  // tslint:disable-next-line:no-any
  const schematicConfigs: any = ['class', 'component', 'directive', 'guard',
                                 'interface', 'module', 'pipe', 'service']
    .map(schematicName => {
      // tslint:disable-next-line:no-any
      const schematicDefaults: JsonObject = (config.defaults as any)[schematicName] || null;

      return {
        schematicName,
        config: schematicDefaults,
      };
    })
    .filter(schematic => schematic.config !== null)
    .reduce((all: JsonObject, schematic) => {
      all[collectionName + ':' + schematic.schematicName] = schematic.config;

      return all;
    }, {});

  const componentUpdate: JsonObject = {};
  componentUpdate.prefix = '';

  const componentKey = collectionName + ':component';
  const directiveKey = collectionName + ':directive';
  if (!schematicConfigs[componentKey]) {
    schematicConfigs[componentKey] = {};
  }
  if (!schematicConfigs[directiveKey]) {
    schematicConfigs[directiveKey] = {};
  }
  if (config.apps && config.apps[0]) {
    schematicConfigs[componentKey].prefix = config.apps[0].prefix;
    schematicConfigs[directiveKey].prefix = config.apps[0].prefix;
  }
  if (config.defaults) {
    schematicConfigs[componentKey].styleext = config.defaults.styleExt;
  }

  return schematicConfigs;
}

function extractArchitectConfig(_config: CliConfig): JsonObject | null {
  return null;
}

function extractProjectsConfig(
  config: CliConfig, tree: Tree, logger: logging.LoggerApi,
): JsonObject {
  const builderPackage = '@angular-devkit/build-angular';
  const defaultAppNamePrefix = getDefaultAppNamePrefix(config);

  const buildDefaults: JsonObject = config.defaults && config.defaults.build
    ? {
      sourceMap: config.defaults.build.sourcemaps,
      progress: config.defaults.build.progress,
      poll: config.defaults.build.poll,
      deleteOutputPath: config.defaults.build.deleteOutputPath,
      preserveSymlinks: config.defaults.build.preserveSymlinks,
      showCircularDependencies: config.defaults.build.showCircularDependencies,
      commonChunk: config.defaults.build.commonChunk,
      namedChunks: config.defaults.build.namedChunks,
    } as JsonObject
    : {};

  const serveDefaults: JsonObject = config.defaults && config.defaults.serve
    ? {
      port: config.defaults.serve.port,
      host: config.defaults.serve.host,
      ssl: config.defaults.serve.ssl,
      sslKey: config.defaults.serve.sslKey,
      sslCert: config.defaults.serve.sslCert,
      proxyConfig: config.defaults.serve.proxyConfig,
    } as JsonObject
    : {};


  const apps = config.apps || [];
  // convert the apps to projects
  const browserApps = apps.filter(app => app.platform !== 'server');
  const serverApps = apps.filter(app => app.platform === 'server');

  const projectMap = browserApps
    .map((app, idx) => {
      const defaultAppName = idx === 0 ? defaultAppNamePrefix : `${defaultAppNamePrefix}${idx}`;
      const name = app.name || defaultAppName;
      const outDir = app.outDir || defaults.outDir;
      const appRoot = app.root || defaults.appRoot;

      function _mapAssets(asset: string | JsonObject) {
        if (typeof asset === 'string') {
          return normalize(appRoot + '/' + asset);
        } else {
          if (asset.allowOutsideOutDir) {
            logger.warn(tags.oneLine`
              Asset with input '${asset.input}' was not migrated because it
              uses the 'allowOutsideOutDir' option which is not supported in Angular CLI 6.
            `);

            return null;
          } else if (asset.output) {
            return {
              glob: asset.glob,
              input: normalize(appRoot + '/' + asset.input),
              output: normalize('/' + asset.output as string),
            };
          } else {
            return {
              glob: asset.glob,
              input: normalize(appRoot + '/' + asset.input),
              output: '/',
            };
          }
        }
      }

      function _buildConfigurations(): JsonObject {
        const source = app.environmentSource;
        const environments = app.environments;
        const serviceWorker = app.serviceWorker;

        if (!environments) {
          return {};
        }

        return Object.keys(environments).reduce((acc, environment) => {
          if (source === environments[environment]) {
            return acc;
          }

          let isProduction = false;

          const environmentContent = tree.read(app.root + '/' + environments[environment]);
          if (environmentContent) {
            isProduction = !!environmentContent.toString('utf-8')
              // Allow for `production: true` or `production = true`. Best we can do to guess.
              .match(/production['"]?\s*[:=]\s*true/);
          }

          let configurationName;
          // We used to use `prod` by default as the key, instead we now use the full word.
          // Try not to override the production key if it's there.
          if (environment == 'prod' && !environments['production'] && isProduction) {
            configurationName = 'production';
          } else {
            configurationName = environment;
          }

          let swConfig: JsonObject | null = null;
          if (serviceWorker) {
            swConfig = {
              serviceWorker: true,
              ngswConfigPath: '/src/ngsw-config.json',
            };
          }

          acc[configurationName] = {
            ...(isProduction
              ? {
                optimization: true,
                outputHashing: 'all',
                sourceMap: false,
                extractCss: true,
                namedChunks: false,
                aot: true,
                extractLicenses: true,
                vendorChunk: false,
                buildOptimizer: true,
              }
              : {}
            ),
            ...(isProduction && swConfig ? swConfig : {}),
            ...(isProduction && app.budgets ? { budgets: app.budgets as JsonArray } : {}),
            fileReplacements: [
              {
                replace: `${app.root}/${source}`,
                with: `${app.root}/${environments[environment]}`,
              },
            ],
          };

          return acc;
        }, {} as JsonObject);
      }

      function _serveConfigurations(): JsonObject {
        const environments = app.environments;

        if (!environments) {
          return {};
        }
        if (!architect) {
          throw new Error();
        }

        const configurations = (architect.build as JsonObject).configurations as JsonObject;

        return Object.keys(configurations).reduce((acc, environment) => {
          acc[environment] = { browserTarget: `${name}:build:${environment}` };

          return acc;
        }, {} as JsonObject);
      }

      function _extraEntryMapper(extraEntry: string | JsonObject) {
        let entry: string | JsonObject;
        if (typeof extraEntry === 'string') {
          entry = join(app.root as Path, extraEntry);
        } else {
          const input = join(app.root as Path, extraEntry.input as string || '');
          entry = { input, lazy: extraEntry.lazy };

          if (extraEntry.output) {
            entry.bundleName = extraEntry.output;
          }
        }

        return entry;
      }

      const project: JsonObject = {
        root: '',
        sourceRoot: 'src',
        projectType: 'application',
      };

      const architect: JsonObject = {};
      project.architect = architect;

        // Browser target
      const buildOptions: JsonObject = {
        // Make outputPath relative to root.
        outputPath: outDir,
        index: `${appRoot}/${app.index || defaults.index}`,
        main: `${appRoot}/${app.main || defaults.main}`,
        tsConfig: `${appRoot}/${app.tsconfig || defaults.tsConfig}`,
        ...buildDefaults,
      };

      if (app.polyfills) {
        buildOptions.polyfills = appRoot + '/' + app.polyfills;
      }

      if (app.stylePreprocessorOptions
          && app.stylePreprocessorOptions.includePaths
          && Array.isArray(app.stylePreprocessorOptions.includePaths)
          && app.stylePreprocessorOptions.includePaths.length > 0) {
        buildOptions.stylePreprocessorOptions = {
          includePaths: app.stylePreprocessorOptions.includePaths
            .map(includePath => join(app.root as Path, includePath)),
        };
      }

      buildOptions.assets = (app.assets || []).map(_mapAssets).filter(x => !!x);
      buildOptions.styles = (app.styles || []).map(_extraEntryMapper);
      buildOptions.scripts = (app.scripts || []).map(_extraEntryMapper);
      architect.build = {
        builder: `${builderPackage}:browser`,
        options: buildOptions,
        configurations: _buildConfigurations(),
      };

      // Serve target
      const serveOptions: JsonObject = {
        browserTarget: `${name}:build`,
        ...serveDefaults,
      };
      architect.serve = {
        builder: `${builderPackage}:dev-server`,
        options: serveOptions,
        configurations: _serveConfigurations(),
      };

      // Extract target
      const extractI18nOptions: JsonObject = { browserTarget: `${name}:build` };
      architect['extract-i18n'] = {
        builder: `${builderPackage}:extract-i18n`,
        options: extractI18nOptions,
      };

      const karmaConfig = config.test && config.test.karma
          ? config.test.karma.config || ''
          : '';
        // Test target
      const testOptions: JsonObject = {
          main: appRoot + '/' + app.test || defaults.test,
          // Make karmaConfig relative to root.
          karmaConfig,
        };

      if (app.polyfills) {
        testOptions.polyfills = appRoot + '/' + app.polyfills;
      }

      if (app.testTsconfig) {
          testOptions.tsConfig = appRoot + '/' + app.testTsconfig;
        }
      testOptions.scripts = (app.scripts || []).map(_extraEntryMapper);
      testOptions.styles = (app.styles || []).map(_extraEntryMapper);
      testOptions.assets = (app.assets || []).map(_mapAssets).filter(x => !!x);

      if (karmaConfig) {
        architect.test = {
          builder: `${builderPackage}:karma`,
          options: testOptions,
        };
      }

      const tsConfigs: string[] = [];
      const excludes: string[] = [];
      if (config && config.lint && Array.isArray(config.lint)) {
        config.lint.forEach(lint => {
          tsConfigs.push(lint.project);
          if (lint.exclude) {
            if (typeof lint.exclude === 'string') {
              excludes.push(lint.exclude);
            } else {
              lint.exclude.forEach(ex => excludes.push(ex));
            }
          }
        });
      }

      const removeDupes = (items: string[]) => items.reduce((newItems, item) => {
        if (newItems.indexOf(item) === -1) {
          newItems.push(item);
        }

        return newItems;
      }, <string[]> []);

        // Tslint target
      const lintOptions: JsonObject = {
        tsConfig: removeDupes(tsConfigs).filter(t => t.indexOf('e2e') === -1),
        exclude: removeDupes(excludes),
      };
      architect.lint = {
          builder: `${builderPackage}:tslint`,
          options: lintOptions,
        };

      // server target
      const serverApp = serverApps
        .filter(serverApp => app.root === serverApp.root && app.index === serverApp.index)[0];

      if (serverApp) {
        const serverOptions: JsonObject = {
          outputPath: serverApp.outDir || defaults.serverOutDir,
          main: serverApp.main || defaults.serverMain,
          tsConfig: serverApp.tsconfig || defaults.serverTsConfig,
        };
        const serverTarget: JsonObject = {
          builder: '@angular-devkit/build-angular:server',
          options: serverOptions,
        };
        architect.server = serverTarget;
      }
      const e2eProject: JsonObject = {
        root: project.root,
        sourceRoot: project.root,
        projectType: 'application',
      };

      const e2eArchitect: JsonObject = {};

      // tslint:disable-next-line:max-line-length
      const protractorConfig = config && config.e2e && config.e2e.protractor && config.e2e.protractor.config
        ? config.e2e.protractor.config
        : '';
      const e2eOptions: JsonObject = {
        protractorConfig: protractorConfig,
        devServerTarget: `${name}:serve`,
      };
      const e2eTarget: JsonObject = {
        builder: `${builderPackage}:protractor`,
        options: e2eOptions,
      };

      e2eArchitect.e2e = e2eTarget;
      const e2eLintOptions: JsonObject = {
        tsConfig: removeDupes(tsConfigs).filter(t => t.indexOf('e2e') !== -1),
        exclude: removeDupes(excludes),
      };
      const e2eLintTarget: JsonObject = {
        builder: `${builderPackage}:tslint`,
        options: e2eLintOptions,
      };
      e2eArchitect.lint = e2eLintTarget;
      if (protractorConfig) {
        e2eProject.architect = e2eArchitect;
      }

      return { name, project, e2eProject };
    })
    .reduce((projects, mappedApp) => {
      const {name, project, e2eProject} = mappedApp;
      projects[name] = project;
      projects[name + '-e2e'] = e2eProject;

      return projects;
    }, {} as JsonObject);

  return projectMap;
}

function getDefaultAppNamePrefix(config: CliConfig) {
  let defaultAppNamePrefix = 'app';
  if (config.project && config.project.name) {
    defaultAppNamePrefix = config.project.name;
  }

  return defaultAppNamePrefix;
}

function extractDefaultProject(config: CliConfig): string | null {
  if (config.apps && config.apps[0]) {
    const app = config.apps[0];
    const defaultAppName = getDefaultAppNamePrefix(config);
    const name = app.name || defaultAppName;

    return name;
  }

  return null;
}

function updateSpecTsConfig(config: CliConfig): Rule {
  return (host: Tree, context: SchematicContext) => {
    const apps = config.apps || [];
    apps.forEach((app: AppConfig, idx: number) => {
      const testTsConfig = app.testTsconfig || defaults.testTsConfig;
      const tsSpecConfigPath = join(normalize(app.root || ''), testTsConfig);
      const buffer = host.read(tsSpecConfigPath);

      if (!buffer) {
        return;
      }


      const tsCfgAst = parseJsonAst(buffer.toString(), JsonParseMode.Loose);
      if (tsCfgAst.kind != 'object') {
        throw new SchematicsException('Invalid tsconfig. Was expecting an object');
      }

      const filesAstNode = findPropertyInAstObject(tsCfgAst, 'files');
      if (filesAstNode && filesAstNode.kind != 'array') {
        throw new SchematicsException('Invalid tsconfig "files" property; expected an array.');
      }

      const recorder = host.beginUpdate(tsSpecConfigPath);

      const polyfills = app.polyfills || defaults.polyfills;
      if (!filesAstNode) {
        // Do nothing if the files array does not exist. This means exclude or include are
        // set and we shouldn't mess with that.
      } else {
        if (filesAstNode.value.indexOf(polyfills) == -1) {
          appendValueInAstArray(recorder, filesAstNode, polyfills);
        }
      }

      host.commitUpdate(recorder);
    });
  };
}

function updatePackageJson(config: CliConfig) {
  return (host: Tree, context: SchematicContext) => {
    const pkgPath = '/package.json';
    const buffer = host.read(pkgPath);
    if (buffer == null) {
      throw new SchematicsException('Could not read package.json');
    }
    const pkgAst = parseJsonAst(buffer.toString(), JsonParseMode.Strict);

    if (pkgAst.kind != 'object') {
      throw new SchematicsException('Error reading package.json');
    }

    const devDependenciesNode = findPropertyInAstObject(pkgAst, 'devDependencies');
    if (devDependenciesNode && devDependenciesNode.kind != 'object') {
      throw new SchematicsException('Error reading package.json; devDependency is not an object.');
    }

    const recorder = host.beginUpdate(pkgPath);
    const depName = '@angular-devkit/build-angular';
    if (!devDependenciesNode) {
      // Haven't found the devDependencies key, add it to the root of the package.json.
      appendPropertyInAstObject(recorder, pkgAst, 'devDependencies', {
        [depName]: latestVersions.DevkitBuildAngular,
      });
    } else {
      // Check if there's a build-angular key.
      const buildAngularNode = findPropertyInAstObject(devDependenciesNode, depName);

      if (!buildAngularNode) {
        // No build-angular package, add it.
        appendPropertyInAstObject(
          recorder,
          devDependenciesNode,
          depName,
          latestVersions.DevkitBuildAngular,
        );
      } else {
        const { end, start } = buildAngularNode;
        recorder.remove(start.offset, end.offset - start.offset);
        recorder.insertRight(start.offset, JSON.stringify(latestVersions.DevkitBuildAngular));
      }
    }

    host.commitUpdate(recorder);

    context.addTask(new NodePackageInstallTask({
      packageManager: config.packageManager === 'default' ? undefined : config.packageManager,
    }));

    return host;
  };
}

function updateTsLintConfig(): Rule {
  return (host: Tree, context: SchematicContext) => {
    const tsLintPath = '/tslint.json';
    const buffer = host.read(tsLintPath);
    if (!buffer) {
      return host;
    }
    const tsCfgAst = parseJsonAst(buffer.toString(), JsonParseMode.Loose);

    if (tsCfgAst.kind != 'object') {
      return host;
    }

    const rulesNode = findPropertyInAstObject(tsCfgAst, 'rules');
    if (!rulesNode || rulesNode.kind != 'object') {
      return host;
    }

    const importBlacklistNode = findPropertyInAstObject(rulesNode, 'import-blacklist');
    if (!importBlacklistNode || importBlacklistNode.kind != 'array') {
      return host;
    }

    const recorder = host.beginUpdate(tsLintPath);
    for (let i = 0; i < importBlacklistNode.elements.length; i++) {
      const element = importBlacklistNode.elements[i];
      if (element.kind == 'string' && element.value == 'rxjs') {
        const { start, end } = element;
        // Remove this element.
        if (i == importBlacklistNode.elements.length - 1) {
          // Last element.
          if (i > 0) {
            // Not first, there's a comma to remove before.
            const previous = importBlacklistNode.elements[i - 1];
            recorder.remove(previous.end.offset, end.offset - previous.end.offset);
          } else {
            // Only element, just remove the whole rule.
            const { start, end } = importBlacklistNode;
            recorder.remove(start.offset, end.offset - start.offset);
            recorder.insertLeft(start.offset, '[]');
          }
        } else {
          // Middle, just remove the whole node (up to next node start).
          const next = importBlacklistNode.elements[i + 1];
          recorder.remove(start.offset, next.start.offset - start.offset);
        }
      }
    }

    host.commitUpdate(recorder);

    return host;
  };
}

export default function (): Rule {
  return (host: Tree, context: SchematicContext) => {
    if (host.exists('/.angular.json') || host.exists('/angular.json')) {
      context.logger.info('Found a modern configuration file. Nothing to be done.');

      return host;
    }

    const configPath = getConfigPath(host);
    const configBuffer = host.read(normalize(configPath));
    if (configBuffer == null) {
      throw new SchematicsException(`Could not find configuration file (${configPath})`);
    }
    const config = parseJson(configBuffer.toString(), JsonParseMode.Loose);

    if (typeof config != 'object' || Array.isArray(config) || config === null) {
      throw new SchematicsException('Invalid angular-cli.json configuration; expected an object.');
    }

    return chain([
      migrateKarmaConfiguration(config),
      migrateConfiguration(config, context.logger),
      updateSpecTsConfig(config),
      updatePackageJson(config),
      updateTsLintConfig(),
      (host: Tree, context: SchematicContext) => {
        context.logger.warn(tags.oneLine`Some configuration options have been changed,
          please make sure to update any npm scripts which you may have modified.`);

        return host;
      },
    ])(host, context);
  };
}
