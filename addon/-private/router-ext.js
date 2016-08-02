import Ember from 'ember';

const {
  Logger: {
    info
  },
  Router,
  RSVP,
  assert,
  get,
  getOwner
} = Ember;

Router.reopen({
  assetLoader: Ember.inject.service(),

  _getHandlerFunction() {
    let seen = {}; // Originally EmptyObject
    let owner = getOwner(this);

    return (name) => {
      console.log('getting', name);
      let __getHandler = (routeName, routeOwner) => {
        let fullRouteName = 'route:' + routeName;

        let handler = routeOwner.lookup(fullRouteName);

        if (seen[name] && handler) {
          return handler;
        }

        seen[name] = true;

        if (!handler) {
          let DefaultRoute = routeOwner._lookupFactory('route:basic');

          routeOwner.register(fullRouteName, DefaultRoute.extend());
          handler = routeOwner.lookup(fullRouteName);

          if (get(this, 'namespace.LOG_ACTIVE_GENERATION')) {
            info(`generated -> ${fullRouteName}`, { fullName: fullRouteName });
          }
        }

        handler.routeName = routeName;

        return handler;
      };

      let engineInfo = this._engineInfoByRoute[name];

      if (engineInfo) {
        return this._getEngineInstance(engineInfo).then((instance) => {
          if (instance) {
            let handler = __getHandler(engineInfo.localFullName, instance);

            // if (engineInfo && !hasDefaultSerialize(handler)) {
            //   throw new Error('Defining a custom serialize method on an Engine route is not supported.');
            // }

            return handler;
          }

          return {};
        });
      }

      return __getHandler(name, owner);
    };
  },

  /**
   * Gets an EngineInstance for a specific type of Engine. Fetching the assets if necessary.
   *
   * @return {Promise}
   */
  _getEngineInstance({ name, instanceId, mountPoint, isLazy }) {
    let engineInstances = this._engineInstances;

    if (!engineInstances[name]) {
      engineInstances[name] = {}; // Originally EmptyObject
    }

    let engineInstance = engineInstances[name][instanceId];

    if (!engineInstance) {
      let owner = getOwner(this);
      if (!owner.hasRegistration('engine:' + name)) {
        console.log('fetching', name);
        return engineInstances[name][instanceId] = this.get('assetLoader').loadBundle(name).then(() => {
          if (!owner.hasRegistration('engine:' + name)) {
            owner.register('engine:' + name, require(name + '/engine').default);
          }

          return (engineInstances[name][instanceId] = this.constructEngineInstance(name, mountPoint));
        });
      }

      engineInstance = this.constructEngineInstance(name, mountPoint);
      engineInstances[name][instanceId] = engineInstance;
    }

    return RSVP.resolve(engineInstance);
  },

  constructEngineInstance(name, mountPoint) {
    let owner = getOwner(this);

    assert(
      'You attempted to mount the engine \'' + name + '\' in your router map, but the engine can not be found.',
      owner.hasRegistration(`engine:${name}`)
    );

    let engineInstance = owner.buildChildEngineInstance(name, {
      routable: true,
      mountPoint
    });

    engineInstance.boot();

    return engineInstance;
  }
});
