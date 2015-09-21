Package.describe({
  name: 'jeremy:reactive-stripe',
  summary: "Stripe.js, Stripe Checkout, and Stripe for Node with a few reactive goodies for Meteor usage.",
  version: '1.0.0',
  git: 'https://github.com/jshimko/meteor-reactive-stripe.git'
});

Package.on_use(function (api) {

  Npm.depends({
    "stripe": "4.0.0"
  });

  api.use([
    'underscore@1.0.3',
    'reactive-var@1.0.5'
  ]);

  api.addFiles('stripe_client.js', 'client');
  api.addFiles('stripe_server.js', 'server');

  api.export('ReactiveStripe', 'client');
  api.export('Stripe', 'server');
});
