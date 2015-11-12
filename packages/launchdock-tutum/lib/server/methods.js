
Meteor.methods({
  'tutum/createStack': function (doc) {

    Logger = Logger.child({
      meteor_method: 'tutum/createStack',
      meteor_method_args: doc,
      userId: this.userId
    });

    if (!Launchdock.api.authCheck(doc.token, this.userId)) {
      var err = "AUTH ERROR: Invalid credentials";

      Logger.error(err);

      throw new Meteor.Error(err);
    }

    check(doc, {
      name: String,
      appImage: Match.Optional(String),
      domainName: Match.Optional(String),
      appEnvVars: Match.Optional([Object]),
      token: Match.Optional(String)
    });

    this.unblock();

    var tutum = new Tutum();

    tutum.checkCredentials();

    if (Stacks.findOne({ name: doc.name, userId: this.userId })) {
      var err = "A stack called '" + doc.name +"' already exists.";

      Logger.error(err);

      throw new Meteor.Error(err);
    }

    var stackId = Stacks.insert({ name: doc.name, state: "Creating" });
    var siteId = stackId.toLowerCase();

    var siteUrl = doc.domainName ? doc.domainName :
                                   siteId + ".getreaction.io";

    var websocketUrl = doc.domainName ? doc.domainName :
                                        siteId + ".getreaction.io";

    var virtualHosts = "http://" + siteUrl + ", ws://" + websocketUrl +
                       ", https://" + siteUrl + ", wss://" + websocketUrl;

    var app = {
      "name": "app-" + stackId,
      "image": doc.appImage || "jshimko/reaction:devel",
      "container_ports": [
        {
          "protocol": "tcp",
          "inner_port": 80
        }
      ],
      "container_envvars": [
        {
          "key": "MONGO_URL",
          "value": "mongodb://myAppUser:myAppPassword@mongo1:27017,mongo2:27017/myAppDatabase"
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
        }, {
          "key": "NODE_TLS_REJECT_UNAUTHORIZED",
          "value": 0
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
      app.container_envvars = app.container_envvars.concat(doc.appEnvVars);
    };

    // Mongo - primary
    var mongo1 = {
      "name": "mongo1-" + stackId,
      "image": "tutum.co/ongoworks/mongo-rep-set:0.2.10",
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
    var mongo2 = {
      "name": "mongo2-" + stackId,
      "image": "tutum.co/ongoworks/mongo-rep-set:0.2.10",
      "container_ports": [
        {
          "protocol": "tcp",
          "inner_port": 27017
        }
      ],
      "tags": [ "mongo2" ],
      "autorestart": "ALWAYS"
    };

    // Mongo - arbiter
    var mongo3 = {
      "name": "mongo3-" + stackId,
      "image": "tutum.co/ongoworks/mongo-rep-set:0.2.10",
      "container_ports": [
        {
          "protocol": "tcp",
          "inner_port": 27017
        }
      ],
      "container_envvars": [
        {
          "key": "JOURNALING",
          "value": "no"
        }
      ],
      "tags": [ "mongo3" ],
      "autorestart": "ALWAYS"
    };

    // configure the stack
    var stackDetails = {
      "name": doc.name + "-" + stackId,
      "services": [ mongo1, mongo2, mongo3 ]
    };

    // create the stack
    try {
      var stack = tutum.create('stack', stackDetails);
    } catch(e) {
      Stacks.remove(stackId);
      throw new Meteor.Error(e);
    }

    // update local database with returned stack details
    Stacks.update({ _id: stackId }, {
      $set: {
        uuid: stack.data.uuid,
        uri: stack.data.resource_uri,
        publicUrl: "https://" + siteUrl,
        state: stack.data.state,
        services: stack.data.services
      }
    });

    // add each of the stack's services to the local Services collection
    tutum.updateStackServices(stack.data.services);

    // start the stack (currently only a mongo cluster)
    try {
      tutum.start(stack.data.resource_uri);
    } catch(e) {
      throw new Meteor.Error(e);
    }

    // watch for mongo stack to be running, then start trying to connect to it
    // (stack state gets updated by persistent Tutum events websocket stream)
    var handle = Stacks.find({ _id: stackId }).observeChanges({
      changed: function (id, fields) {
        if (fields.state && fields.state === 'Running') {

          // get the container URI for the mongo primary
          var mongoPrimary = Services.findOne({ name: 'mongo1-' + stackId });
          var mongo1Containers = tutum.getServiceContainers(mongoPrimary.uri);

          // parse UUID from URI
          var mongoUuid = mongo1Containers[0].substring(18, mongo1Containers[0].length - 1);

          // open websocket and try to connect to mongo
          tutum.checkMongoState(mongoUuid, function (err, ready) {
            if (ready) {
              // add the app to the stack
              Logger.info("Adding the app to the stack " + stackId);
              try {
                var fullStack = tutum.update(stack.data.resource_uri, {
                  "services": [ app, mongo1, mongo2, mongo3 ]
                });
              } catch(e) {
                Logger.error("Error adding app container to stack " + stackId);
                throw new Meteor.Error(e);
              }

              // update the stack services locally again
              tutum.updateStackServices(fullStack.data.services);
              Stacks.update({ _id: stackId }, { $set: { services: fullStack.data.services }});

              // start the app service
              var appService = Services.findOne({ name: "app-" + stackId });
              try {
                tutum.start(appService.uri);
              } catch(e) {
                Logger.error("Error starting app service in stack " + stackId);
                throw new Meteor.Error(e);
              }

              // link the load balancer to the app service
              try {
                tutum.addLinkToLoadBalancer(appService.name, appService.uri);
                tutum.reloadLoadBalancers();
              } catch (e) {
                Logger.error("Error adding link to load balancer for stack " + stackId);
                throw new Meteor.Error(e);
              }
            }
          });

          handle.stop();
        }
      }
    });

    return stackId;
  },


  'tutum/deleteStack': function (id) {

    Logger = Logger.child({
      meteor_method: 'tutum/deleteStack',
      meteor_method_args: id,
      userId: this.userId
    });

    if (! Users.is.admin(this.userId)) {
      var msg = "Method 'tutum/deleteStack': Must be admin.";
      Logger.error(msg);
      throw new Meteor.Error(msg);
    }

    check(id, String);

    var tutum = new Tutum();

    tutum.checkCredentials();

    var stack = Stacks.findOne(id);

    try {
      var res = tutum.delete(stack.uri);

      if (res.statusCode == 202) {
        // TODO - set stack to "terminated" and
        // then remove it after a minute or two delay
        Stacks.remove({ _id: id });
        Services.remove({ stack: stack.uri });
      }

      Logger.info("Stack " + id + " deleted successfully.");
      return res;
    } catch(e) {
      throw new Meteor.Error(e);
    }
  },


  'tutum/updateSSLCert'(doc, stackId) {

    Logger = Logger.child({
      meteor_method: 'tutum/updateSSLCert',
      meteor_method_args: doc,
      userId: this.userId
    });

    // TODO: make this a setting on the client
    doc.$set.customSSLActive = true;

    // so we don't need to have this remotely
    doc.$set.lastUpdatedBy = this.userId;

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
      Logger.error(err);
      throw new Meteor.Error(err);
    }

    const appService = Services.findOne({ name: 'app-' + stackId });

    if (!appService) {
      const err = "App service not found";
      Logger.error(err);
      throw new Meteor.Error(err);
    }

    // combine private key and cert to create pem file
    const pem = doc.$set.sslPrivateKey + "\n" + doc.$set.sslPublicCert;

    // replace all new lines with "\n"
    const pemEnvVar = pem.replace(/(?:\r\n|\r|\n)/g, '\\n');

    doc.$set.sslPem = pem;

    Stacks.update(stackId, doc);

    const tutum = new Tutum();

    tutum.checkCredentials();

    try {
      tutum.addCustomSSL(appService.uri, doc.$set.sslDomainName, pemEnvVar, true);
    } catch(e) {
      Logger.error(e);
      throw new Meteor.Error(e);
    }

    try {
      tutum.redeploy(appService.uri);
    } catch(e) {
      Logger.error(e);
      throw new Meteor.Error(e);
    }

    Stacks.update(stackId, doc);

    Logger.info("Updated SSL cert for stack: " + stackId);

    return true;
  }

});
