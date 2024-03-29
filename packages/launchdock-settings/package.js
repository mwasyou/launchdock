Package.describe({
  name: 'launchdock:settings',
  summary: 'Launchdock settings package'
});

Package.onUse(function(api) {

  api.versionsFrom(['METEOR@1.2.1']);

  api.use([
    'launchdock:lib',
    'launchdock:users'
  ]);

  api.addFiles([
    'lib/settings.js',
    'lib/utils.js'
  ], ['client', 'server']);

  api.addFiles([
    'lib/server/main.js',
    'lib/server/permissions.js',
    'lib/server/publications.js'
  ], 'server');

  api.addFiles([
    'lib/client/helpers.js',
    'lib/client/templates/settings_form.html',
    'lib/client/templates/settings_form.js',
    'lib/client/templates/settings_form.scss'
  ], 'client');

  api.export('Settings');
});
