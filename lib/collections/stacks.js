/**
 * Stacks schema
 * @type {SimpleSchema}
 */

Stacks = new Mongo.Collection('stacks');

Stacks.schema = new SimpleSchema({

  name: {
    type: String,
    optional: false
  },

  appImage: {
    type: String,
    optional: true
  },

  domainName: {
    type: String,
    optional: true
  },

  subDomain: {
    type: String,
    optional: true
  },

  uuid: {
    type: String,
    optional: true
  },

  uri: {
    type: String,
    optional: true
  },

  publicUrl: {
    type: String,
    optional: true
  },

  defaultDomain: {
    type: String,
    optional: true
  },

  state: {
    type: String,
    optional: true
  },

  services: {
    type: [String],
    optional: true
  },

  endpoint: {
    type: String,
    optional: true
  },
  
  sslPrivateKey: {
    type: String,
    optional: true
  },

  sslPublicCert: {
    type: String,
    optional: true
  },

  sslPem: {
    type: String,
    optional: true
  },

  sslDomainName: {
    type: String,
    optional: true
  },

  customSSLActive: {
    type: Boolean,
    optional: true
  },

  userId: {
    type: String,
    optional: true
  },

  createdAt: {
    type: Date,
    label: 'Created',
    autoValue: function() {
      if (this.isInsert) {
        return new Date();
      } else if (this.isUpsert) {
        return {
          $setOnInsert: new Date()
        };
      } else {
        this.unset();
      }
    }
  },

  updatedAt: {
    type: Date,
    label: 'Updated',
    autoValue: function() {
      if (this.isUpdate) {
        return new Date();
      }
    },
    denyInsert: true,
    optional: true
  },

  lastUpdatedBy: {
    type: String,
    optional: true,
    denyInsert: true,
    autoValue: function () {
      if (this.isUpdate && this.userId) {
        return this.userId;
      }
    }
  }

});

/**
 * Attach schema to Stacks collection
 */
Stacks.attachSchema(Stacks.schema);
