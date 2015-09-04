// On first start, seed the database with some default data if none exists.

Meteor.startup(function() {

  var defaultUsers = [{
    email: 'jeremy.shimko@gmail.com',
    username: 'admin',
    password: '0ng0w0rks',
    roles: ['admin']
  }];

  if (Meteor.users.find().count() < 1) {

    _.each(defaultUsers, function(user) {
      var id;

      id = Accounts.createUser({
        email: user.email,
        username: user.username,
        password: user.password
      });

      if (user.roles.length > 0) {
        Roles.addUsersToRoles(id, user.roles, Roles.GLOBAL_GROUP);
      }
    });

    console.log('New default users created!');
  };

  if (Settings.find().count() < 1) {
    var id = Settings.insert({siteTitle: 'Launchdock'});
    console.log('Default settings document created: ', id);
  }
});
