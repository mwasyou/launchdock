
Meteor.methods({
  'tutum/createStack'(doc, userId) {

    const logger = Logger.child({
      meteor_method: 'tutum/createStack',
      meteor_method_args: doc,
      userId: userId || this.userId
    });

    // confirms this is being called by Drive or a Launchdock admin
    if (!Launchdock.api.authCheck(doc.token, this.userId)) {
      const err = "AUTH ERROR: Invalid credentials";
      logger.error(err);
      throw new Meteor.Error(err);
    }

    check(doc, {
      name: String,
      appImage: Match.Optional(String),
      domainName: Match.Optional(String),
      appEnvVars: Match.Optional([Object]),
      token: Match.Optional(String)
    });

    if (!this.userId) {
      check(userId, String);

      // if a userId was passed in, make sure that user exists
      if (!Users.findOne(userId)) {
        const err = `User ${userId} not found.`;
        logger.error(err);
        throw new Meteor.Error(err);
      }
    }

    this.unblock();

    const user = userId || this.userId;

    const tutum = new Tutum();

    tutum.checkCredentials();

    if (Stacks.findOne({ name: doc.name, userId: user })) {
      const err = `A stack called ${doc.name} already exists.`;
      logger.error(err);
      throw new Meteor.Error(err);
    }

    const appImage = doc.appImage || Settings.get("defaultAppImage");

    if (!appImage) {
      const err = "No default app image specified.";
      logger.error(err);
      throw new Meteor.Error(err);
    }

    const wildcardDomain = Settings.get("tutumWildcardDomain");

    if (!doc.domainName && !wildcardDomain) {
      const err = "Wildcard domain not configured on settings page.";
      logger.error(err);
      throw new Meteor.Error(err);
    }

    const stackId = Stacks.insert({
      name: doc.name,
      appImage: appImage,
      state: "Creating",
      userId: user
    });

    logger.info(`New stack ${stackId} created`);

    const stack = Stacks.findOne(stackId);

    const siteId = stackId.toLowerCase();

    const siteUrl = doc.domainName ? doc.domainName :
                                     siteId + "." + wildcardDomain;

    const virtualHosts = "http://" + siteUrl + ", ws://" + siteUrl +
                       ", https://" + siteUrl + ", wss://" + siteUrl;

    // mongo environment variables
    const mongoRootUser = Random.id();
    const mongoRootPw = Random.id(30);
    const mongoUser = Random.id();
    const mongoPw = Random.id(30);
    const mongoDatabase = Random.id();
    const mongoRepSetId = Random.id();

    // mongo urls
    const mongoBaseUrl = `mongodb://${mongoUser}:${mongoPw}@mongo1:27017,mongo2:27017/`;
    const mongoUrl = mongoBaseUrl + mongoDatabase + "?replicaSet=" + mongoRepSetId;
    const mongoOplogUrl = mongoBaseUrl + "local?authSource=" + mongoDatabase;

    // app container configuration
    const app = {
      "name": "app-" + stackId,
      "image": appImage,
      "container_ports": [
        {
          "protocol": "tcp",
          "inner_port": 80
        }
      ],
      "container_envvars": [
        {
          "key": "LAUNCHDOCK_STACK_ID",
          "value": stackId
        }, {
          "key": "LAUNCHDOCK_STACK_CREATED",
          "value": stack.createdAt
        }, {
          "key": "LAUNCHDOCK_DEFAULT_DOMAIN",
          "value": siteUrl
        }, {
          "key": "LAUNCHDOCK_BALANCER_ENDPOINT",
          "value": Settings.get("loadBalancerEndpoint", ""),
        }, {
          "key": "MONGO_URL",
          "value": mongoUrl
        }, {
          "key": "MONGO_OPLOG_URL",
          "value": mongoOplogUrl
        }, {
          "key": "ROOT_URL",
          "value": "https://" + siteUrl
        }, {
          "key": "VIRTUAL_HOST",
          "value": virtualHosts
        }, {
          "key": "PORT",
          "value": 80
        }, {
          "key": "FORCE_SSL",
          "value": "yes"
        }
      ],
      "linked_to_service": [
        {
          "to_service": "mongo1-" + stackId,
          "name": "mongo1"
        }, {
          "to_service": "mongo2-" + stackId,
          "name": "mongo2"
        }
      ],
      "tags": [ "app" ],
      // "target_num_containers": 2,
      "sequential_deployment": true,
      "deployment_strategy": "HIGH_AVAILABILITY",
      "autorestart": "ALWAYS"
    };

    // add custom environment variables to app (if any were provided)
    if (doc.appEnvVars) {
      logger.debug("Appending customer env vars to stack", doc.appEnvVars);
      app.container_envvars = app.container_envvars.concat(doc.appEnvVars);
    };

    const mongoImage = Settings.get("mongoImage", "launchdock/mongo-rep-set:latest");

    // Mongo - primary
    const mongo1 = {
      "name": "mongo1-" + stackId,
      "image": mongoImage,
      "container_ports": [
        {
          "protocol": "tcp",
          "inner_port": 27017
        }
      ],
      "container_envvars": [
        {
          "key": "MONGO_ROLE",
          "value": "primary"
        }, {
          "key": "MONGO_SECONDARY",
          "value": "mongo2-" + stackId
        }, {
          "key": "MONGO_ARBITER",
          "value": "mongo3-" + stackId
        }, {
          "key": "MONGO_ROOT_USER",
          "value": mongoRootUser
        }, {
          "key": "MONGO_ROOT_PASSWORD",
          "value": mongoRootPw
        }, {
          "key": "MONGO_APP_USER",
          "value": mongoUser
        }, {
          "key": "MONGO_APP_PASSWORD",
          "value": mongoPw
        }, {
          "key": "REP_SET",
          "value": mongoRepSetId
        }, {
          "key": "MONGO_APP_DATABASE",
          "value": mongoDatabase
        }
      ],
      "linked_to_service": [
        {
          "to_service": "mongo2-" + stackId,
          "name": "mongo2"
        }, {
          "to_service": "mongo3-" + stackId,
          "name": "mongo3"
        }
      ],
      "tags": [ "mongo1" ],
      "autorestart": "ALWAYS"
    };

    // Mongo - secondary
    const mongo2 = {
      "name": "mongo2-" + stackId,
      "image": mongoImage,
      "container_ports": [
        {
          "protocol": "tcp",
          "inner_port": 27017
        }
      ],
      "container_envvars": [
        {
          "key": "REP_SET",
          "value": mongoRepSetId
        }
      ],
      "tags": [ "mongo2" ],
      "autorestart": "ALWAYS"
    };

    // Mongo - arbiter
    const mongo3 = {
      "name": "mongo3-" + stackId,
      "image": mongoImage,
      "container_ports": [
        {
          "protocol": "tcp",
          "inner_port": 27017
        }
      ],
      "container_envvars": [
        {
          "key": "REP_SET",
          "value": mongoRepSetId
        }, {
          "key": "JOURNALING",
          "value": "no"
        }
      ],
      "tags": [ "mongo3" ],
      "autorestart": "ALWAYS"
    };

    // configure the stack
    const stackDetails = {
      "name": doc.name + "-" + stackId,
      "services": [ mongo1, mongo2, mongo3 ]
    };

    // create the stack
    let tutumStack;
    try {
      tutumStack = tutum.create('stack', stackDetails);
    } catch(e) {
      Stacks.remove(stackId);
      logger.error(e);
      throw new Meteor.Error(e);
    }

    logger.info("Tutum stack created", tutumStack.data);

    // update local database with returned stack details
    Stacks.update({ _id: stackId }, {
      $set: {
        uuid: tutumStack.data.uuid,
        uri: tutumStack.data.resource_uri,
        publicUrl: "https://" + siteUrl, // TODO change to defaultUrl across app
        defaultDomain: siteUrl,
        state: tutumStack.data.state,
        services: tutumStack.data.services,
        endpoint: Launchdock.tutum.getLoadBalancerEndpoint()
      }
    }, (err, num) => {
      if (err) {
        logger.error(err);
      } else {
        logger.debug(`Stack ${stackId} updated with Tutum stack details`);
      }
    });

    // add each of the stack's services to the local Services collection
    tutum.updateStackServices(stack, tutumStack.data.services);

    // start the stack (currently only a mongo cluster)
    try {
      tutum.start(tutumStack.data.resource_uri);
      logger.info("Mongo stack started on Tutum.");
    } catch(e) {
      logger.error(e);
      throw new Meteor.Error(e);
    }

    // watch for mongo stack to be running, then start trying to connect to it
    // (stack state gets updated by persistent Tutum events websocket stream)
    const handle = Stacks.find({ _id: stackId }).observeChanges({
      changed: function (id, fields) {
        if (fields.state && fields.state === 'Running') {

          // get the container URI for the mongo primary
          const mongoPrimary = Services.findOne({ name: 'mongo1-' + stackId });
          const mongo1Containers = tutum.getServiceContainers(mongoPrimary.uri);

          // parse UUID from URI
          const mongoUuid = mongo1Containers[0].substring(18, mongo1Containers[0].length - 1);

          // open websocket and try to connect to mongo
          tutum.checkMongoState(mongoUuid, function (err, ready) {
            if (ready) {
              // add the app to the stack
              let fullStack;
              try {
                logger.info(`Adding the app service to stack ${stackId}`);
                fullStack = tutum.update(tutumStack.data.resource_uri, {
                  "services": [ app, mongo1, mongo2, mongo3 ]
                });
              } catch(e) {
                logger.error("Error adding app container to stack " + stackId);
                throw new Meteor.Error(e);
              }

              // update the stack services locally again
              tutum.updateStackServices(stack, fullStack.data.services);
              Stacks.update({ _id: stackId }, { $set: { services: fullStack.data.services }});

              // start the app service
              const appService = Services.findOne({ name: "app-" + stackId });
              try {
                logger.info(`Starting app service ${appService._id}`);
                tutum.start(appService.uri);
              } catch(e) {
                logger.error(`Error starting app service ${appService._id} in stack ${stackId}`);
                throw new Meteor.Error(e);
              }

              // link the load balancer to the app service
              try {
                logger.info("Linking app service to load balancer");
                tutum.addLinkToLoadBalancer(appService.name, appService.uri);
              } catch (e) {
                logger.error(`Error adding link to load balancer for stack ${stackId}`);
                throw new Meteor.Error(e);
              }
            }
          });

          handle.stop();
        }
      }
    });

    // notify admins via email if in production
    if (Launchdock.isProduction()) {
      const currentUser = Users.findOne({ _id: this.userId });

      let userInfo;

      // if launched in Launchdock dashboard,
      // use current user's email
      if (currentUser) {
        userInfo = currentUser.emails[0].address;
      }

      // if launched via API with default METEOR_USER set,
      // use that email instead
      _.each(app.container_envvars, (envVar) => {
        if (envVar.key === "METEOR_USER") {
          userInfo = envVar.value;
        }
      });

      // define email options
      const subject = `New stack creation for ${siteUrl} by ${userInfo}`;
      const text = `User: ${userInfo} \n Shop: https://${siteUrl}`;

      // send the email to all users with admin role
      Launchdock.email.sendToAdmins(subject, text);
    }

    return stackId;
  },


  'tutum/deleteStack'(id) {

    const logger = Logger.child({
      meteor_method: 'tutum/deleteStack',
      meteor_method_args: id,
      userId: this.userId
    });

    if (! Users.is.admin(this.userId)) {
      const err = "AUTH ERROR: Must be admin.";
      logger.error(err);
      throw new Meteor.Error(err);
    }

    check(id, String);

    const tutum = new Tutum();

    tutum.checkCredentials();

    const stack = Stacks.findOne(id);

    let res;
    try {
      res = tutum.delete(stack.uri);

      if (res.statusCode == 202) {
        // TODO - set stack to "terminated" and
        // then remove it after a minute or two delay
        Stacks.remove({ _id: id });
        Services.remove({ stack: stack.uri });
      }

      logger.info("Stack " + id + " deleted successfully.");
    } catch(e) {
      throw new Meteor.Error(e);
    }

    analytics.track({
      userId: this.userId,
      event: "Stack Deleted",
      properties: {
        stackId: stack._id,
        stackUserId: stack.userId
      }
    });

    return res;
  },


  'tutum/updateSSLCert'(doc, stackId) {

    const logger = Logger.child({
      meteor_method: 'tutum/updateSSLCert',
      meteor_method_args: doc,
      userId: this.userId
    });

    // TODO: make this a setting on the client
    doc.$set.customSSLActive = true;

    check(doc.$set, {
      sslPrivateKey: String,
      sslPublicCert: String,
      sslDomainName: String,
      customSSLActive: Boolean,
      updatedAt: Date,
      lastUpdatedBy: String
    });

    check(stackId, String);

    const stack = Stacks.findOne(stackId);

    if (!stack) {
      const err = "Stack not found";
      logger.error(err);
      throw new Meteor.Error(err);
    }

    // must either own the stack or be an admin
    if (stack.userId !== this.userId || !Users.is.admin(this.userId)) {
      const err = "AUTH ERROR: You can't do that.";
      logger.error(err);
      throw new Meteor.Error(err);
    }

    const appService = Services.findOne({ name: 'app-' + stackId });

    if (!appService) {
      const err = "App service not found";
      logger.error(err);
      throw new Meteor.Error(err);
    }

    // combine private key and cert to create pem file
    const customPem = doc.$set.sslPrivateKey + "\n" + doc.$set.sslPublicCert;

    // grab default wildcard pem for default url's
    const defaultPem = Launchdock.ssl.getDefaultPem();

    // combine them
    const pem = customPem + "\n" + defaultPem;

    // add to update object
    doc.$set.sslPem = customPem;

    // replace all new lines with "\n" for haproxy environment variable
    const pemEnvVar = pem.replace(/(?:\r\n|\r|\n)/g, '\\n');

    const sslOpts = {
      defaultDomain: stack.defaultDomain,
      customDomain: doc.$set.sslDomainName,
      pem: pemEnvVar
    };

    const tutum = new Tutum();

    tutum.checkCredentials();

    try {
      tutum.addCustomSSL(appService.uri, sslOpts);
    } catch(e) {
      logger.error(e);
      throw new Meteor.Error(e);
    }

    try {
      tutum.redeploy(appService.uri);
    } catch(e) {
      logger.error(e);
      throw new Meteor.Error(e);
    }

    Stacks.update(stackId, doc);

    logger.info("Updated SSL cert for stack: " + stackId);

    analytics.track({
      userId: this.userId,
      event: "Stack SSL settings updated",
      properties: {
        stackId: stack._id,
        stackUserId: stack.userId,
        defaultDomain: sslOpts.defaultDomain,
        customDomain: sslOpts.customDomain
      }
    });

    return true;
  },


  'tutum/getLoadBalancerEndpoint'(serviceUri) {

    const logger = Logger.child({
      meteor_method: 'tutum/getLoadBalancerEndpoint',
      meteor_method_args: serviceUri,
      userId: this.userId
    });

    if (!this.userId) {
      const err = "Auth error.";
      logger.error(err);
      throw new Meteor.Error(err);
    }

    check(serviceUri, Match.Optional(String));

    logger.info("Method 'tutum/getLoadBalancerEndpoint' called by: " + this.userId);

    // currently only one LB service running, so this is a placeholder
    return Launchdock.tutum.getLoadBalancerEndpoint();
  }

});
