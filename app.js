var config = require(__dirname + '/config/app_config.json');

var express = require('express');
var app = express();
var http = require('http').Server(app);
var stathat = require('node-stathat');
var request = require('superagent');

var mysql = require('mysql');
var connection = mysql.createConnection({
  host: config.SQL_HOST,
  user: config.SQL_USER,
  password: config.SQL_PASSWORD,
  database: config.SQL_DB
});

var query = 'select round((count(phone_number) + (select count(*) from ' + config.SQL_DB + '.mailchimp_sub )) *.905) as total from ' + config.SQL_DB + '.mobile_users where status = \'Active Subscriber\'';

connection.on('error', function() {
  console.log("MYSQL Connection Error!");
  stathat.trackEZCount(config.STATHAT, 'dsrealtime-counter-sql_error', 1, function(status, response){});
});

var memberCount = -1;

app.get('/', function(req, res){
 	res.send('This counts things.');
});

function getMemberCount(callback) {
  connection.query(query, function(err, rows, fields) {
    if(err) {
      console.log(err);
    }
    if(rows[0] == undefined) {
      console.log("Recieved bad data, not updating");
      stathat.trackEZCount(config.STATHAT, 'dsrealtime-counter-sql_error', 1, function(status, response){});
      return;
    }
    if(memberCount != -1 && rows[0].total < (memberCount - 50000)) { //allows for margin of error
      console.log("Lower member count than there should be");
      stathat.trackEZCount(config.STATHAT, 'dsrealtime-counter-low_count', 1, function(status, response){});
      return;
    }
    memberCount = rows[0].total;
    stathat.trackEZCount(config.STATHAT, 'dsrealtime-counter-total', memberCount, function(status, response){});
    callback(rows[0]);
  });
}

function updateApplications() {
  getMemberCount(function(data) {
    updateDrupal(data);
  });
  updateDashboard();
}

function updateDrupal(data) {
  request
   .post(config.DRUPAL_AUTH)
   .set('Content-Type', 'application/json')
   .set('Accept', 'application/json')
   .send({"username": config.DRUPAL_USERNAME, "password": config.DRUPAL_PASSWORD})
   .end(function(res){
      var raw = res.body;
      var drupalToken = raw.token;
      var drupalSessid = raw.sessid;
      var drupalSessionName = raw.session_name;
      request
       .post(config.SET_VAR)
       .set('Accept', 'application/json')
       .set("Content-type", "application/json")
       .set("X-CSRF-Token", drupalToken)
       .set("Cookie", drupalSessionName + "=" + drupalSessid)
       .send({"name": "dosomething_user_member_count", "value": data.total})
       .end(function(res){
         console.log("Updated Drupal, Status Code: " + res.status);
         if(res.status != 200) {
           stathat.trackEZCount(config.STATHAT, 'dsrealtime-counter-drupal_error', 1, function(status, response){});
         }
      });
  });
}

/*
 * Temp. solution to the Heroku dyno taking a nap...
 */
function updateDashboard() {
  request
    .get("https://dsrealtimefeed.herokuapp.com/")
    .end(function(res) {
      console.log("Pinged Dashboard, " + res.status)
      if(res.status != 200) {
        stathat.trackEZCount(config.STATHAT, 'dsrealtime-feed-cant_ping', 1, function(status, response){});
      }
    });
}

process.on('uncaughtException', function (err) {
    console.log(err);
});

var server = app.listen(41523, function() {
    console.log('Listening on port %d', server.address().port);
    updateApplications();
    setInterval(updateApplications, (5 * 60) * 1000); //Updates every 5 minutes
});
