var fs = require('fs');
var path = require('path');
var Funnel = require('broccoli-funnel');
var Plugin = require('broccoli-plugin');
var rollup = require('rollup').rollup;
var amdNameResolver = require('amd-name-resolver').moduleResolve;
var existsSync = require('exists-sync');

// Create a subclass RollupFunnel derived from Plugin
RollupFunnel.prototype = Object.create(Plugin.prototype);
RollupFunnel.prototype.constructor = RollupFunnel;
function RollupFunnel(inputNodes, options) {
  if (!(this instanceof RollupFunnel)) {
    return new RollupFunnel(inputNodes, options);
  }

  if (!(options.include ^ options.exclude)) {
    throw new Error('Must specify exactly one of `include` or `exclude`.');
  }

  this.originalInput = inputNodes;
  options = options || {};
  Plugin.call(this, [inputNodes], {
    annotation: options.annotation
  });
  this.options = options;
}

RollupFunnel.prototype._copy = Funnel.prototype._copy;

RollupFunnel.prototype.build = function() {
  var base = this.inputPaths[0];
  var modules = [];
  var rollupOptions = {
    entry: this.options.rollup.entry,
    dest: 'foo.js',
    plugins: [
      {
        resolveId: function(importee, importer) {
          var moduleName;

          // This will only ever be the entry point.
          if (!importer) {
            moduleName = importee.replace(base, '');
            modules.push(moduleName);
            return path.join(base, importee);
          }

          // Link in the global paths.
          moduleName = amdNameResolver(importee, importer).replace(base, '').replace(/^\//, '');
          var modulePath = path.join(base, moduleName + '.js');
          if (existsSync(modulePath)) {
            modules.push(moduleName + '.js');
            return modulePath;
          }
        }
      }
    ]
  };

  return rollup(rollupOptions).then(function() {
    if (this.options.include) {
      modules.map(function(module) {
        var inputPath = path.join(this.inputPaths[0], module);
        var outputPath = path.join(this.outputPath, module);
        this._copy(inputPath, outputPath);
      }, this);
    } else if (this.options.exclude) {
      fs.readdirSync(this.inputPaths[0]).forEach(function(module) {
        if (modules.indexOf(module)) { return; }

        var inputPath = path.join(this.inputPaths[0], module);
        var outputPath = path.join(this.outputPath, module);
        this._copy(inputPath, outputPath);
      }, this);
    }
  }.bind(this));
};

module.exports = RollupFunnel;
