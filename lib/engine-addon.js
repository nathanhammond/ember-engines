var Funnel = require('broccoli-funnel');
var merge = require('lodash/merge');
var mergeTrees = require('broccoli-merge-trees');
var existsSync = require('exists-sync');
var fs = require('fs');
var path = require('path');
var writeFile = require('broccoli-file-creator');
var babelTranspiler = require('broccoli-babel-transpiler');
var concat = require('broccoli-concat');

function buildChildAppTree() {
  var treesForApp = this.eachAddonInvoke('treeFor', ['app']);
  return mergeTrees(treesForApp, { overwrite: true });
}

function buildConfigTree(prefix) {
  // Include a module that reads the engine's configuration from its
  // meta tag and exports its contents.
  var configContents = this.getEngineConfigContents();
  var configTree = writeFile(prefix + '/config/environment.js', configContents);

  return configTree;
}

module.exports = {
  extend: function(options) {
    var originalInit = options.init || function() { this._super.init.apply(this, arguments); };
    options.init = function() {
      // NOTE: This is to deal with core object calling toString on the function.
      // What a beautiful hack.
      // this._super()

      var result = originalInit.apply(this, arguments);

      // Require that the user specify a lazyLoading property.
      if (!('lazyLoading' in this)) {
        this.ui.writeDeprecateLine(this.pkg.name + ' engine must specify the `lazyLoading` property to `true` or `false` as to whether the engine should be lazily loaded.');
      }

      // Null out the treeForAddon so that when this thing gets built it doesn't get merged into the combined addons.
      var originalTreeForAddon = this.treeForAddon;
      this.treeForAddon = function(engineSourceTree) {
        if (this.lazyLoading === true) {
          // LAZY LOADING!
          var compiledAddonTree = this.compileAddon(engineSourceTree);

          return new Funnel(compiledAddonTree, {
            include: ['modules/' + this.name + '/routes.js']
          });
        } else {
          // NOT LAZY LOADING!
          var engineJSTree = originalTreeForAddon.apply(this, arguments);
          var childAppTree = buildChildAppTree.call(this);
          var configTree = buildConfigTree.call(this, '/modules/' + this.name)

          var childAppTreeRelocated = new Funnel(childAppTree, {
            destDir: 'modules/' + this.name
          });

          return mergeTrees([childAppTreeRelocated, engineJSTree, configTree], { overwrite: true });
        }
      };

      // We're instead going to manually insert this addon into the public folder by modifying behavior here.
      var originalTreeForPublic = this.treeForPublic;
      this.treeForPublic = function() {
        var publicResult = originalTreeForPublic.apply(this, arguments);

        if (this.lazyLoading !== true) {
          return publicResult;
        }

        var childAppTree = buildChildAppTree.call(this);
        var configTree = buildConfigTree.call(this, this.name)

        var childAppTreeRelocated = new Funnel(childAppTree, {
          destDir: this.name
        });
        var publicMoved = new Funnel(publicResult, {
          destDir: 'engines-dist'
        });

        var treePath = path.resolve(this.root, this.treePaths['addon']);
        var engineSourceTree;

        if (existsSync(treePath)) {
          engineSourceTree = this.treeGenerator(treePath);
        }

        var engineJSTree = this.compileAddon(engineSourceTree);
        var engineJSTreeWithoutRoutes = new Funnel(engineJSTree, {
          exclude: ['modules/'+this.name+'/routes.js']
        });

        // Move out of modules and into the engine-dist directory.
        var engineJSTreeRelocated = new Funnel(engineJSTreeWithoutRoutes, {
          srcDir: 'modules',
          destDir: '/'
        });

        var engineAndChildAppTrees = mergeTrees([childAppTreeRelocated, engineJSTreeRelocated, configTree], { overwrite: true });

        // Babelify
        // FIXME: not copypasta
        var amdNameResolver = require('amd-name-resolver').moduleResolve;
        var babelOptions = {
          modules: 'amdStrict',
          moduleIds: true,
          resolveModuleSource: amdNameResolver
        };

        var transpiledEngineTree = babelTranspiler(engineAndChildAppTrees, babelOptions);

        var concatTranspiledEngineTree = concat(transpiledEngineTree, {
          inputFiles: ['**/*.js'],
          outputFile: 'engines-dist/' + this.name + '/engine.js'
        });

        // Get base styles tree.
        var engineStylesTree = this.compileStyles(this._treeFor('addon-styles'));

        // Move styles tree into the correct place.
        var primaryStyleTree = new Funnel(engineStylesTree, {
          include: [this.name + '.css'],

          getDestinationPath: function(relativePath) {
            return 'engine.css';
          },

          destDir: 'engines-dist/' + this.name
        });

        var secondaryStylesTree = new Funnel(engineStylesTree, {
          exclude: [this.name + '.css'],
          destDir: 'engines-dist/' + this.name
        });

        return mergeTrees([publicMoved, concatTranspiledEngineTree, primaryStyleTree, secondaryStylesTree].filter(Boolean), { overwrite: true });
      };

      return result;
    };

    if (options.treeFor) {
      throw new Error('Do not provide a custom `options.treeFor` with `EngineAddon.extend(options)`.');
    }
    if (options.treeForAddon) {
      throw new Error('Do not provide a custom `options.treeForAddon` with `EngineAddon.extend(options)`.');
    }

    /**
      Returns configuration settings that will augment the application's
      configuration settings.

      By default, engines return `null`, and maintain their own separate
      configuration settings which are retrieved via `engineConfig()`.

      @public
      @method config
      @param {String} env Name of current environment (e.g. "developement")
      @param {Object} baseConfig Initial application configuration
      @return {Object} Configuration object to be merged with application configuration.
    */
    options.config = options.config || function(env, baseConfig) {
      return null;
    };

    /**
      Returns an engine's configuration settings, to be used exclusively by the
      engine.

      By default, this method simply reads the configuration settings from
      an engine's `config/environment.js`.

      @public
      @method engineConfig
      @param {String} env Name of current environment (e.g. "developement")
      @param {Object} baseConfig Initial engine configuration
      @return {Object} Configuration object that will be provided to the engine.
    */
    options.engineConfig = function(env, baseConfig) {
      var configPath = 'config';

      if (this.pkg['ember-addon'] && this.pkg['ember-addon']['engineConfigPath']) {
        configPath = this.pkg['ember-addon']['engineConfigPath'];
      }

      configPath = path.join(this.root, configPath, 'environment.js');

      if (existsSync(configPath)) {
        var configGenerator = require(configPath);

        var engineConfig = configGenerator(env, baseConfig);

        var addonsConfig = this.getAddonsConfig(env, engineConfig);

        return merge(addonsConfig, engineConfig);
      } else {
        return this.getAddonsConfig(env, {});
      }
    };

    /**
      Returns the addons' configuration.

      @private
      @method getAddonsConfig
      @param  {String} env           Environment name
      @param  {Object} engineConfig  Engine configuration
      @return {Object}               Merged configuration of all addons
     */
    options.getAddonsConfig = function(env, engineConfig) {
      this.initializeAddons();

      var initialConfig = merge({}, engineConfig);

      return this.addons.reduce(function(config, addon) {
        if (addon.config) {
          merge(config, addon.config(env, config));
        }

        return config;
      }, initialConfig);
    };

    /**
      Overrides the content provided for the `head` section to include
      the engine's configuration settings as a meta tag.

      @public
      @method contentFor
      @param type
      @param config
    */
    options.contentFor = function(type, config) {
      if (type === 'head') {
        var engineConfig = this.engineConfig(config.environment, {});

        var content = '<meta name="' + options.name + '/config/environment" ' +
                      'content="' + escape(JSON.stringify(engineConfig)) + '" />';

        return content;
      }

      return '';
    };

    /**
      Returns the contents of the module to be used for accessing the Engine's
      config.

      @public
      @method getEngineConfigContents
      @return {String}
    */
    options.getEngineConfigContents = options.getEngineConfigContents || function() {
      var configTemplatePath = path.join(__dirname, '/engine-config-from-meta.js');
      var configTemplate = fs.readFileSync(configTemplatePath, { encoding: 'utf8' });
      return configTemplate.replace('{{MODULE_PREFIX}}', options.name);
    };

    /**
      FIXME:

      @public
      @method treeFor
      @param {String} name
      @return {Tree}
    */
    options.treeFor = function treeFor(name) {
      var tree, trees;

      this._requireBuildPackages();

      if (name === 'app') {
        trees = [];
      } else {
        trees = this.eachAddonInvoke('treeFor', [name]);
      }

      if (tree = this._treeFor(name)) {
        trees.push(tree);
      }

      if (this.isDevelopingAddon() && this.hintingEnabled() && name === 'app') {
        trees.push(this.jshintAddonTree());
      }

      return mergeTrees(trees.filter(Boolean), {
        overwrite: true,
        annotation: 'Engine#treeFor (' + options.name + ' - ' + name + ')'
      });
    };
    return options;
  }
}
