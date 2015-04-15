define(function(require, exports, module) {
    main.consumes = ["Plugin", "automate", "vfs", "c9", "proc", "fs"];
    main.provides = ["installer"];
    return main;

    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var automate = imports.automate;
        var c9 = imports.c9;
        var proc = imports.proc;
        var fs = imports.fs;
        
        /***** Initialization *****/
        
        var plugin = new Plugin("Ajax.org", main.consumes);
        var emit = plugin.getEmitter();
        
        var NAMESPACE = "installer";
        var installSelfCheck = options.installSelfCheck && c9.platform != "win32";
        var installChecked = false;
        
        var packages = {};
        var sessions = [];
        var installed = false;
        var installCb, arch;
        
        // Check that all the dependencies are installed
        var VERSION = 1;
        createSession("Cloud9 IDE", VERSION, require("./install/install"));
        
        function load() {
            imports.vfs.on("beforeConnect", function(e) {
                if (!installSelfCheck || installChecked)
                    return e.done(false);
                
                installCb = e.done;
                
                if (!proc.installMode)
                    readFromDisk(e.vfs);
                else
                    proc.installMode = e.vfs;
                
                return false;
            });
        }
        
        /***** Methods *****/
        
        function readFromDisk(vfs){
            function done(err){
                if (!installed) installed = {};
                
                if (err && err.code == "ENOENT" || installed["Cloud9 IDE"] !== VERSION) {
                    // Tmux and pty.js are probably not installed. Lets switch 
                    // to a special mode of proc
                    proc.installMode = vfs;
                    
                    // Wait until installer is done
                    plugin.on("stop", function listen(e){
                        if (e.session.package.name == "Cloud9 IDE") {
                            proc.installMode = false;
                            installChecked = true;
                            installCb(true);
                            installCb = null;
                            plugin.off("stop", listen);
                        }
                    });
                }
                else {
                    installChecked = true;
                    installCb();
                    installCb = null;
                }
                
                emit.sticky("ready", installed);
            }
            
            vfs.readfile(options.installPath.replace(c9.home, "~") + "/installed", {
                encoding: "utf8"
            }, function(err, meta) {
                if (err) return done(err);
                
                var data = "";
                var stream = meta.stream;
                stream.on("data", function(chunk){ data += chunk; });
                stream.on("end", function(){ 
                    if (data.match(/^1[\r\n]*$/)) // Backwards compatibility
                        data = "Cloud9 IDE@1\nc9.ide.collab@1\nc9.ide.find@1";
                    
                    installed = {};
                    data.split("\n").forEach(function(line){
                        if (!line) return;
                        var p = line.split("@");
                        installed[p[0]] = parseInt(p[1], 10);
                    });
                    
                    done();
                });
            });
        }
        
        function addPackageManager(name, implementation){
            automate.addCommand(NAMESPACE, name, implementation);
        }
        
        function removePackageManager(name) {
            automate.removeCommand(NAMESPACE, name);
        }

        // Add aliases to support a broader range of platforms
        function addPackageManagerAlias(){
            var args = [NAMESPACE];
            for (var i = 0; i < arguments.length; i++) {
                args.push(arguments[i]);
            }
            
            automate.addCommandAlias.apply(this, args);
        }
        
        function reinstall(packageName){
            if (packages[packageName]) {
                createSession(packageName, packages[packageName].version, 
                    packages[packageName].populate, null, true);
                return true;
            }
            
            return false;
        }
        
        function createSession(packageName, packageVersion, populateSession, callback, force) {
            if (!installed) {
                return plugin.on("ready", 
                    createSession.bind(this, packageName, packageVersion, populateSession, callback));
            }
            if (!c9.isReady) {
                return c9.on("ready", 
                    createSession.bind(this, packageName, packageVersion, populateSession, callback));
            }
            
            if (typeof packageVersion == "function") {
                force = callback;
                callback = populateSession;
                populateSession = packageVersion;
                packageVersion = populateSession.version;
            }
            
            packages[packageName] = { 
                version: packageVersion, 
                populate: populateSession 
            };
            
            if (installed[packageName] == packageVersion)
                return callback && callback();
            
            var session = automate.createSession(NAMESPACE);
            
            var add = session.task; delete session.task;
            function install(options, task, validate) {
                if (!task || typeof task == "function") {
                    if (typeof task == "function")
                        validate = task;
                    task = options;
                    options = {};
                }
                
                add(task, options, validate);
            }
            
            function start(callback, force) {
                if (force || emit("beforeStart", { session: session }) !== false) {
                    // Pre script
                    if (pre) session.tasks.unshift({ "bash": pre });
                    
                    // Post script
                    if (post) session.tasks.push({ "bash": post });
                    
                    // Start installation
                    session.run(callback);
                }
            }
            
            session.on("run", function(){
                emit("start", { session: session }); 
            });
            session.on("stop", function(err){
                sessions.remove(session);
                emit("stop", { session: session, error: err });
                callback && callback(err);
                
                // Update installed file
                if (!err) {
                    installed[packageName] = packageVersion;
                    var contents = Object.keys(installed).map(function(item){
                        return item + "@" + installed[item]
                    }).join("\n");
                    fs.writeFile("~/.c9/installed", contents, function(){});
                }
            });
            session.on("each", function(e){
                emit("each", e); 
            });
            
            var intro, pre, post;
            session.freezePublicAPI({
                /**
                 * 
                 */
                package: {
                    name: packageName,
                    version: packageVersion
                },
                
                /**
                 * 
                 */
                get introduction(){ return intro; },
                set introduction(value){ intro = value; },
                /**
                 * 
                 */
                get preInstallScript(){ return pre; },
                set preInstallScript(value){ pre = value; },
                /**
                 * 
                 */
                get postInstallScript(){ return post; },
                set postInstallScript(value){ post = value; },
                
                /**
                 * 
                 */
                install: install,
                
                /**
                 * 
                 */
                start: start
            });
            
            session.on("unload", function(){
                sessions.remove(session);
            }, plugin);
            
            sessions.push(session);
            
            if (arch === undefined) {
                arch = null;
                proc.execFile("uname", { args: ["-m"] }, function(e, p) {
                    if (/x86_64/.test(p)) p = "x64";
                    else if (/i.*86/) p = "x86";
                    else if (/armv6l|armv7l/) p = "x86";
                    arch = p || undefined;
                    emit.sticky("arch", arch);
                });
            }
            
            plugin.once("arch", function() {
                populateSession(session, {
                    platform: c9.platform,
                    arch: arch
                });
            });
        }
        
        /***** Lifecycle *****/
        
        plugin.on("load", function() {
            load();
        });
        plugin.on("unload", function() {
            installChecked = false;
            installed = false;
            installCb = arch = undefined;
        });
        
        /***** Register and define API *****/
        
        /**
         * 
         **/
        plugin.freezePublicAPI({
            /**
             * 
             */
            get sessions(){ return sessions; },
            
            /**
             * 
             */
            get installed(){ return installed; },
            
            /**
             * 
             */
            get checked(){ return installChecked; },
            
            _events: [
                /**
                 * @event beforeStart
                 */
                "beforeStart",
                /**
                 * @event start
                 */
                "start",
                /**
                 * @event stop
                 */
                "stop",
                /**
                 * @event each
                 */
                "each"
            ],
            
            /**
             * 
             */
            reinstall: reinstall,
            
            /**
             * 
             */
            createSession: createSession,
            
            /**
             * 
             */
            addPackageManager: addPackageManager,
            
            /**
             * 
             */
            removePackageManager: removePackageManager,
            
            /**
             * 
             */
            addPackageManagerAlias: addPackageManagerAlias,
        });
        
        register(null, {
            installer: plugin
        });
    }
});