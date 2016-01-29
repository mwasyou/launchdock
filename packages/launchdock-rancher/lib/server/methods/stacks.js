
Meteor.methods({
  'rancher/createStack'(doc, userId) {

    const logger = Logger.child({
      meteor_method: 'rancher/createStack',
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

    const rancher = new Rancher();

    rancher.checkCredentials();

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

    const wildcardDomain = Settings.get("wildcardDomain");

    if (!doc.domainName && !wildcardDomain) {
      const err = "Wildcard domain not configured on settings page.";
      logger.error(err);
      throw new Meteor.Error(err);
    }

    // create the stack locally
    const stackId = Stacks.insert({
      name: doc.name,
      appImage: appImage,
      state: "Creating",
      userId: user
    });

    logger.info(`New stack ${stackId} created`);

    // create the stack on Rancher
    let rancherStack;
    try {
      rancherStack = rancher.create("stacks", {
        name: doc.name + "-" + stackId
      });
    } catch(e) {
      Stacks.remove(stackId);
      logger.error(e);
      throw new Meteor.Error(e);
    }

    logger.info("Rancher stack created", rancherStack.data);

    // update local database with returned stack details
    Stacks.update({ _id: stackId }, {
      $set: {
        rancherId: rancherStack.data.id,
        uuid: rancherStack.data.uuid,
        defaultUrl: "https://" + siteUrl,
        defaultDomain: siteUrl,
        state: rancherStack.data.state,
        endpoint: Settings.get("loadBalancerEndpoint")
      }
    }, (err, num) => {
      if (err) {
        logger.error(err);
      } else {
        logger.debug(`Stack ${stackId} updated with Rancher stack details`);
      }
    });

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
      "name": `app-${stackId}`,
      "scale": 1,
      "environmentId": rancherStack.id,
      "launchConfig": {
        "hostname": `app-${stackId}`,
        "imageUuid": `docker:${appImage}`,
        "environment": {
          "LAUNCHDOCK_STACK_ID": stackId,
          "LAUNCHDOCK_STACK_CREATED": stack.createdAt,
          "LAUNCHDOCK_DEFAULT_DOMAIN": siteUrl,
          "LAUNCHDOCK_BALANCER_ENDPOINT": Settings.get("loadBalancerEndpoint", ""),
          "MONGO_URL": mongoUrl,
          "MONGO_OPLOG_URL": mongoOplogUrl,
          "ROOT_URL": "https://" + siteUrl,
          "VIRTUAL_HOST": virtualHosts,
          "PORT": 80,
          "FORCE_SSL": "yes"
        },
        "labels": {
          "io.rancher.scheduler.affinity:host_label": "host_type=app"
        },
        "restartPolicy": {
          "name": "always"
        },
        "startOnCreate": false
      }
    };

    // TODO: format objects in Rancher syntax
    // add custom environment variables to app (if any were provided)
    if (doc.appEnvVars) {
      logger.debug("Appending customer env vars to stack", doc.appEnvVars);
      app.container_envvars = app.container_envvars.concat(doc.appEnvVars);
    };

    const mongoImage = Settings.get("mongoImage", "launchdock/mongo-rep-set:latest");

    // mongo - primary
    const mongo1 = {
      "name": `mongo1-${stackId}`,
      "scale": 1,
      "environmentId": rancherStack.id,
      "launchConfig": {
        "hostname": `mongo1-${stackId}`,
        "imageUuid": `docker:${mongoImage}`,
        "environment": {
          "MONGO_ROLE": "primary",
          "MONGO_SECONDARY": "mongo2-" + stackId,
          "MONGO_ARBITER": "mongo3-" + stackId,
          "MONGO_ROOT_USER": mongoRootUser,
          "MONGO_ROOT_PASSWORD": mongoRootPw,
          "MONGO_APP_USER": mongoUser,
          "MONGO_APP_PASSWORD": mongoPw,
          "REP_SET": mongoRepSetId,
          "MONGO_APP_DATABASE": mongoDatabase
        },
        "labels": {
          "io.rancher.scheduler.affinity:host_label": "host_type=mongo1"
        },
        "restartPolicy": {
          "name": "always"
        },
        "startOnCreate": false
      }
    };

    // mongo - secondary
    const mongo2 = {
      "name": `mongo2-${stackId}`,
      "scale": 1,
      "environmentId": rancherStack.id,
      "launchConfig": {
        "hostname": `mongo2-${stackId}`,
        "imageUuid": `docker:${mongoImage}`,
        "environment": {
          "REP_SET": mongoRepSetId
        },
        "labels": {
          "io.rancher.scheduler.affinity:host_label": "host_type=mongo2"
        },
        "restartPolicy": {
          "name": "always"
        },
        "startOnCreate": false
      }
    };

    // mongo - arbiter
    const mongo3 = {
      "name": `mongo3-${stackId}`,
      "scale": 1,
      "environmentId": rancherStack.id,
      "launchConfig": {
        "hostname": `mongo3-${stackId}`,
        "imageUuid": `docker:${mongoImage}`,
        "environment": {
          "JOURNALING": "no",
          "REP_SET": mongoRepSetId
        },
        "labels": {
          "io.rancher.scheduler.affinity:host_label": "host_type=mongo3"
        },
        "restartPolicy": {
          "name": "always"
        },
        "startOnCreate": false
      }
    };

    // add each of the stack's services to the local Services collection
    // TODO: build this method
    rancher.updateStackServices(stack);

    // start the stack (currently only a mongo cluster)
    try {
      // TODO: finish start method
      rancher.start(stack);
      logger.info("Mongo stack started on Rancher.");
    } catch(e) {
      logger.error(e);
      throw new Meteor.Error(e);
    }

    // TODO: convert to Rancher syntax
    // watch for mongo stack to be running, then start trying to connect to it
    // (stack state gets updated by persistent Rancher events websocket stream)
    const handle = Stacks.find({ _id: stackId }).observeChanges({
      changed: function (id, fields) {
        if (fields.state && fields.state === 'Running') {

          // get the container URI for the mongo primary
          const mongoPrimary = Services.findOne({ name: 'mongo1-' + stackId });
          const mongo1Containers = rancher.getServiceContainers(mongoPrimary.uri);

          // parse UUID from URI
          const mongoUuid = mongo1Containers[0].substring(18, mongo1Containers[0].length - 1);

          // open websocket and try to connect to mongo
          rancher.checkMongoState(mongoUuid, function (err, ready) {
            if (ready) {
              // add the app to the stack
              let fullStack;
              try {
                logger.info(`Adding the app service to stack ${stackId}`);
                fullStack = rancher.update(rancherStack.data.resource_uri, {
                  "services": [ app, mongo1, mongo2, mongo3 ]
                });
              } catch(e) {
                logger.error("Error adding app container to stack " + stackId);
                throw new Meteor.Error(e);
              }

              // update the stack services locally again
              rancher.updateStackServices(stack, fullStack.data.services);
              Stacks.update({ _id: stackId }, { $set: { services: fullStack.data.services }});

              // start the app service
              const appService = Services.findOne({ name: "app-" + stackId });
              try {
                logger.info(`Starting app service ${appService._id}`);
                rancher.start(appService.uri);
              } catch(e) {
                logger.error(`Error starting app service ${appService._id} in stack ${stackId}`);
                throw new Meteor.Error(e);
              }

              // link the load balancer to the app service
              try {
                logger.info("Linking app service to load balancer");
                rancher.addLinkToLoadBalancer(appService.name, appService.uri);
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
      // TODO: convert to Rancher env var syntax
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


  // TODO: convert to Rancher syntax
  'rancher/deleteStack'(id) {

    const logger = Logger.child({
      meteor_method: 'rancher/deleteStack',
      meteor_method_args: id,
      userId: this.userId
    });

    if (! Users.is.admin(this.userId)) {
      const err = "AUTH ERROR: Must be admin.";
      logger.error(err);
      throw new Meteor.Error(err);
    }

    check(id, String);

    const rancher = new Rancher();

    rancher.checkCredentials();

    const stack = Stacks.findOne(id);

    let res;
    try {
      res = rancher.delete(stack.uri);

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
  }

});