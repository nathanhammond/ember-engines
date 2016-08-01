var Funnel = require('broccoli-funnel');
var merge = require('lodash/merge');
var mergeTrees = require('broccoli-merge-trees');
var existsSync = require('exists-sync');
var fs = require('fs');
var path = require('path');
var writeFile = require('broccoli-file-creator');
var babelTranspiler = require('broccoli-babel-transpiler');
var concat = require('broccoli-concat');
var rollupFunnel = require('./rollup-funnel');
var amdNameResolver = require('amd-name-resolver').moduleResolve;

/**
  This is an extraction of what would normally be run by the `treeFor` hook.
  Because we call it in two different places we've moved it to a utility function.
 */
function buildChildAppTree() {
  var treesForApp = this.eachAddonInvoke('treeFor', ['app']);
  return mergeTrees(treesForApp, { overwrite: true });
}

/**
  The config tree is a new concept for an engine.
  We need to build a separate config file for it.
 */
function buildConfigTree(prefix) {
  // Include a module that reads the engine's configuration from its
  // meta tag and exports its contents.
  var configContents = this.getEngineConfigContents();
  var configTree = writeFile(prefix + '/config/environment.js', configContents);

  return configTree;
}

function buildVendorTree() {
  // Manually invoke the child addons addon trees.
  var childAddonsAddonTrees = this.eachAddonInvoke('treeFor', ['addon']);
  var childAddonsAddonTreesMerged = mergeTrees(childAddonsAddonTrees, { overwrite: true });

  return childAddonsAddonTreesMerged;
}

function buildVendorJSTree(vendorTree) {
  // Filter out the JS so that we can process it correctly.
  var vendorJSTree = new Funnel(vendorTree, {
    include: ['**/*.js']
  });

  var vendorJSTreeRelocated = new Funnel(vendorJSTree, {
    srcDir: 'modules',
    destDir: '/'
  });

  return vendorJSTreeRelocated;
}

function buildVendorCSSTree(vendorTree) {
  // Filter out the CSS so that we can process it correctly.
  return new Funnel(vendorTree, {
    include: ['**/*.css']
  });
}

function buildEngineAppTree(engineSourceTree) {
  if (!engineSourceTree) {
    var treePath = path.resolve(this.root, this.treePaths['addon']);
    if (existsSync(treePath)) {
      engineSourceTree = this.treeGenerator(treePath);
    }
  }

  var childAppTree = buildChildAppTree.call(this);
  var childAppTreeRelocated = new Funnel(childAppTree, {
    destDir: this.name
  });

  var engineTree = this.compileAddon(engineSourceTree);
  var engineTreeRelocated = new Funnel(engineTree, {
    srcDir: 'modules',
    destDir: '/'
  });

  var configTree = buildConfigTree.call(this, this.name)

  return mergeTrees([childAppTreeRelocated, engineTreeRelocated, configTree], { overwrite: true })
}


function buildCompleteJSTree(engineSourceTree) {
  var vendorTree = buildVendorTree.call(this);
  var vendorJSTree = buildVendorJSTree.call(this, vendorTree);
  var engineAppTree = buildEngineAppTree.call(this, engineSourceTree);

  return mergeTrees(
    [
      vendorJSTree,
      engineAppTree
    ],
    { overwrite: true }
  );
}

module.exports = {
  extend: function(options) {
    var originalInit = options.init || function() { this._super.init.apply(this, arguments); };
    options.init = function() {
      // NOTE: This is a beautiful hack to deal with core object calling toString on the function.
      // It'll throw a deprecation warning if this isn't present because it doesn't see a `_super`
      // invocation. Do not remove the following line!
      // this._super()

      var result = originalInit.apply(this, arguments);

      // Require that the user specify a lazyLoading property.
      if (!('lazyLoading' in this)) {
        this.ui.writeDeprecateLine(this.pkg.name + ' engine must specify the `lazyLoading` property to `true` or `false` as to whether the engine should be lazily loaded.');
      }

      // Replace `treeForAddon` so that we control how this engine gets built.
      // We may or may not want it to be combined like a default addon.
      var originalTreeForAddon = this.treeForAddon;
      this.treeForAddon = function(engineSourceTree) {
        if (this.lazyLoading === true) {
          // LAZY LOADING!
          // The only thing that we want to promote from a lazy engine is the routes.js file.
          // ... and all of its dependencies.

          var completeJSTree = buildCompleteJSTree.call(this, engineSourceTree);

          // Splice out the routes.js file and its dependencies.
          // We will push these into the host application.
          var engineRoutesTree = rollupFunnel(completeJSTree, {
            include: true,
            rollup: {
              entry: this.name+'/routes.js'
            }
          });

          // But they needto me in the modules directory for later processing.
          return new Funnel(engineRoutesTree, {
            srcDir: '/',
            destDir: 'modules'
          });
        } else {
          // NOT LAZY LOADING!
          // This is the scenario where we want to act like an addon.
          var engineTree = originalTreeForAddon.apply(this, arguments);
          var childAppTree = buildChildAppTree.call(this);
          var configTree = buildConfigTree.call(this, '/modules/' + this.name)

          var childAppTreeRelocated = new Funnel(childAppTree, {
            destDir: 'modules/' + this.name
          });

          return mergeTrees([childAppTreeRelocated, engineTree, configTree], { overwrite: true });
        }
      };

      // We want to do the default `treeForPublic` behavior if we're not a lazy loading engine.
      // If we are a lazy loading engine we now have to manually do the compilation steps for the engine.
      // Luckily the public folder gets merged into the right place in the final output.
      // We'll take advantage of that.
      var originalTreeForPublic = this.treeForPublic;
      this.treeForPublic = function() {
        // NOT LAZY LOADING!
        // In this scenario we just want to do the default behavior and bail.
        var publicResult = originalTreeForPublic.apply(this, arguments);

        if (this.lazyLoading !== true) {
          return publicResult;
        }

        // LAZY LOADING!
        // But we have to implement everything manually for the lazy loading scenario.

        // Move the public tree. It is already all in a folder named `this.name`
        var publicRelocated = new Funnel(publicResult, {
          destDir: 'engines-dist'
        });

        var vendorTree = buildVendorTree.call(this);
        var vendorJSTree = buildVendorJSTree.call(this, vendorTree);
        var vendorCSSTree = buildVendorJSTree.call(this, vendorTree);
        var engineAppTree = buildEngineAppTree.call(this);

        // Splice out the routes.js file which we pushed into the host application.
        var engineAppTreeWithoutRoutes = rollupFunnel(engineAppTree, {
          exclude: true,
          rollup: {
            entry: this.name+'/routes.js'
          }
        });

        // Babelify, but only to the extent of converting modules.
        var babelOptions = {
          modules: 'amdStrict',
          moduleIds: true,
          resolveModuleSource: amdNameResolver
        };

        var transpiledEngineTree = babelTranspiler(engineAppTreeWithoutRoutes, babelOptions);

        // Concatenate all of the JavaScript into a single file.
        var concatTranspiledEngineTree = concat(transpiledEngineTree, {
          allowNone: true,
          inputFiles: ['**/*.js'],
          outputFile: 'engines-dist/' + this.name + '/assets/engine.js'
        });

        // Combine all of the "vendor" trees which have JavaScript.
        var transpiledVendorTree = babelTranspiler(vendorJSTree, babelOptions);

        // And concatenate them.
        var concatTranspiledVendorJSTree = concat(transpiledVendorTree, {
          allowNone: true,
          inputFiles: ['**/*.js'],
          outputFile: 'engines-dist/' + this.name + '/assets/engine-vendor.js'
        });

        var concatTranspiledVendorStylesTree = concat(vendorCSSTree, {
          allowNone: true,
          inputFiles: ['**/*.css'],
          outputFile: 'engines-dist/' + this.name + '/assets/engine-vendor.css'
        });

        // Get base styles tree.
        var engineStylesTree = this.compileStyles(this._treeFor('addon-styles'));

        // Move styles tree into the correct place.
        // `**/*.css` all gets merged.
        // The addon.css file has already been renamed to match `this.name`.
        // All we need to do is concatenate it down.
        var primaryStyleTree = concat(engineStylesTree, {
          allowNone: true,
          inputFiles: ['**/*.css'],
          outputFile: 'engines-dist/' + this.name + '/assets/engine.css'
        });

        // Merge all of our final trees!
        return mergeTrees(
          [
            publicRelocated,
            concatTranspiledVendorStylesTree,
            primaryStyleTree,
            concatTranspiledVendorJSTree,
            concatTranspiledEngineTree
          ].filter(Boolean),
          { overwrite: true }
        );
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
      Returns the appropriate set of trees for this engine's child addons
      given a type of tree. It will merge these trees (if present) with the
      engine's tree of the same name.

      @public
      @method treeFor
      @param {String} name
      @return {Tree}
    */
    options.treeFor = function treeFor(name) {
      this._requireBuildPackages();

      /**
        Scenarios where we don't want to call `eachAddonInvoke`:
        - app tree.
        - addon tree of a lazy engine.

        We handle these cases manually inside of treeForPublic.
        This is to consolidate child dependencies of this engine
        into the engine namespace as opposed to shoving them into
        the host application's vendor.js file.
       */

      var trees;
      if ((name === 'app') || (name === 'addon' && this.lazyLoading === true)) {
        trees = [];
      } else {
        trees = this.eachAddonInvoke('treeFor', [name]);
      }

      // The rest of this is the default implementation of `treeFor`.

      var tree = this._treeFor(name);

      if (tree) {
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
