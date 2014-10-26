var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var stathat = require('node-stathat');
var parseString = require('xml2js').parseString;
var request = require('superagent');
var cheerio = require('cheerio');
var fs = require("fs");
var amqp = require('amqp');
var PHPUnserialize = require('php-unserialize');

var countFile = require('./count.json');
var totalUsers = countFile.total;

var app_config = require(__dirname + '/config/app_config.json');

var drupalToken;
var drupalSessid;
var drupalSessionName;

app.get('/', function(req, res){
 	res.send('Hi, how can I help you? Do you belong here? Whats your name? What is the answer to everything?');
});

app.get('/total', function(req, res){
	res.json(getCountJSON());
});

io.on('connection', function(socket){
	socket.emit('count', totalUsers);
});

/*
 * Paginates through the last minute of mobile commons data & finds how many people
 * signed up
 */
function getMessages(pageNumber){
	var now = new Date();
	var minAgo = new Date();
	minAgo.subMinutes(1);

	request
	.get('https://secure.mcommons.com/api/messages')
	.auth(app_config.mobile_commons.user, app_config.mobile_commons.pass)
	.query({start_time: minAgo.toISOString(), include_profile: 'false', end_time: now.toISOString(), limit: '1000', page: pageNumber, include_profile: 'true'})
	.buffer()
	.accept('xml')
	.type('xml')
	.end(function(res){
	 	parseString(res.text, function (err, result) {
			var jsonResult = JSON.stringify(result);
			if(jsonResult == undefined){
				return;
			}
			var obj = JSON.parse(jsonResult);

			if(obj.response.messages[0].message == undefined){
				return;
			}

			for(var index = 0; index < obj.response.messages[0].message.length; index++){
				var message = obj.response.messages[0].message[index];
				if(message == undefined){
					continue;
				}
				if(message.profile[1] == undefined){
				  	continue;
				}
				if(message['$'].type == "opt_in"){
				  increaseMemberCount();
				}
			}

			var page = parseInt(obj.response.messages[0]['$'].page);
			var totalPages = parseInt(obj.response.messages[0]['$'].page_count);
			if(page >= totalPages){
				resetTimer();
			}
			else{
				getMessages(page + 1);
			}
		});
	});

}

/*
 * Grabs the latest messages after 61 seconds.
 * Does not use interval because the timer waits for the last 'GetMessages' to
 * finish. Uses a seperate function to call getMessages in order to pass the
 * start page (1)
 */
function resetTimer(){
	setTimeout(function(){
		getMessages(1);
	}, 61 * 1000);
}

var conn = amqp.createConnection({
  host: app_config.message_broker.host,
  port: app_config.message_broker.port,
  login: app_config.message_broker.login,
  password: app_config.message_broker.password,
  connectionTimeout: app_config.message_broker.connectionTimeout,
  authMechanism: app_config.message_broker.authMechanism,
  vhost: app_config.message_broker.vhost,
  noDelay: app_config.message_broker.noDelay,
  ssl: { enabled : app_config.message_broker.ssl_enabled }
},
{
  defaultExchangeName: app_config.message_broker.defaultExchangeName
});

conn.on('ready', function(){
  console.log('rabbit connection ready');
  var q = conn.queue('activityStatsQueue', {
    passive: app_config.message_broker.passive,
    durable: app_config.message_broker.durable,
    exclusive: app_config.message_broker.exclusive,
    autoDelete: app_config.message_broker.autoDelete
  }, function (q) {
    console.log('Queue ' + q.name + ' is open');

    q.bind('#');

    q.subscribe(function (message) {
    	var serializedMessage = PHPUnserialize.unserialize(message.data.toString());
      	var activity = serializedMessage.activity;
      	switch(activity){
       		case "user_register":
          		increaseMemberCount();
          		break;
        	default:
          		break;
      	}
    });

  });
});

/*
 * Function for replacing in a string
 */
function replaceAll(find, replace, str) {
 	return str.replace(new RegExp(find, 'g'), replace);
}

function increaseMemberCount(){
	totalUsers++;
	io.emit(totalUsers);
}

Date.prototype.subMinutes = function(m) {
    this.setTime(this.getTime() - (m * 60000));
    return this;
}

function getCountJSON(){
	return {count: totalUsers};
}

function processUsers(raw){
	var data = JSON.parse(raw);
	var remoteTotal = data.total;
	if(remoteTotal > totalUsers){
		totalUsers = remoteTotal;
	}
	countFile.total = totalUsers;
	fs.writeFile("count.json", JSON.stringify(countFile));
	//updateLobbyDash();
	//setInterval(updateLobbyDash, 60 * 1000);
}

function backupLoop(){
	countFile.total = totalUsers;
	fs.writeFile("count.json", JSON.stringify(countFile));
}

function connectSSH(callback){
	var childProcess = require('child_process').spawn;
	var ssh = childProcess('ssh', [
	    '-p',
	    '38383',
	    'dosomething@admin.dosomething.org',
	    'cat ../../tmp/member_count.json'
	]).on('exit', function(code){
		console.log("Done: " + code);
	});

	ssh.stdout.on('data', function(data) {
    	callback((data.toString())); 
	});
}

function connectToDrupal(callback){
	request
	 .post(app_config.drupal_auth_url)
	 .set('Content-Type', 'application/json')
	 .set('Accept', 'application/json')
	 .send({"username": app_config.drupal_app_username, "password": app_config.drupal_app_password})
	 .end(function(res){
	 	var raw = res.body;
	 	drupalToken = raw.token;
	 	drupalSessid = raw.sessid;
	 	drupalSessionName = raw.session_name;
	 	callback();
	 });
}

function postLoop(){
	request
     .post(app_config.drupal_var_url)
     .set('Accept', 'application/json')
     .set("Content-type", "application/json")
     .set("X-CSRF-Token", drupalToken)
     .set("Cookie", drupalSessionName + "=" + drupalSessid)
     .send({"name": "dosomething_user_member_count", "value": totalUsers})
     .end(function(res){});
}

function handleDrupalUpdate(){
	connectToDrupal(function(){
		console.log("Drupal auth complete");
    	postLoop();
    });
}

function handleSSHUpdate(){
    connectSSH(function(raw){
    	processUsers(raw);
    });
}

function updateLobbyDash(){
	request
     .post("http://lobby.dosomething.org:3000/setcount/" + totalUsers + "/" + app_config.lobby_dash_password)
     //.post("http://localhost:3000/setcount/" + totalUsers + "/" + app_config.lobby_dash_password)
     .end(function(res){
     	console.log("Lobby updated " + res.body);
     });
}

process.on('uncaughtException', function (err) {
  console.log('Caught exception: ' + err);
});

var server = app.listen(4012, function() {
    console.log('Listening on port %d', server.address().port);
    getMessages(1);
    handleDrupalUpdate();
    setInterval(handleDrupalUpdate, app_config.post_frequency * 1000);
    handleSSHUpdate();
    setInterval(handleSSHUpdate, 10 * 1000);
    setInterval(backupLoop, app_config.backup_time * 1000);
});