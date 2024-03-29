Package.describe({
  name: 'launchdock:accounts-reaction',
  summary: 'Reaction accounts integration.'
});

Package.onUse(function (api) {

  api.versionsFrom(['METEOR@1.2.1']);

  api.use([
    'launchdock:lib',
    'launchdock:settings',
    'launchdock:tutum',
    'launchdock:users'
  ]);

  api.addFiles([
    'lib/server/main.js',
    'lib/server/publications.js',
    // 'lib/server/methods/intercom.js',
    'lib/server/methods/users.js',
    'lib/server/methods/utils.js'
  ], ['server']);

  api.addAssets([
    'lib/server/email/invitation.html'
  ], 'server');

});
