define(function(require, exports, module) {
    main.consumes = ["Wizard", "WizardPage", "ui", "installer", "Datagrid"];
    main.provides = ["installer.gui"];
    return main;

    function main(options, imports, register) {
        var Wizard = imports.Wizard;
        var WizardPage = imports.WizardPage;
        var ui = imports.ui;
        var installer = imports.installer;
        var Datagrid = imports.Datagrid;
        
        var async = require("async");
        
        /***** Initialization *****/
        
        var plugin = new Wizard("Ajax.org", main.consumes, {
            title: "Cloud9 Installer",
            allowClose: true,
            class: "installer",
            resizable: true,
            height: 400
        });
        
        var logDiv, spinner, lastOutput, datagrid, aborting;
        var intro, overview, execute, complete;
        var sessions = [];
        var executeList;
        
        function load(){
            if (options.testing)
                return plugin.show(true);
            
            installer.on("beforeStart", beforeStart, plugin);
        }
        
        function beforeStart(e){
            aborting = false;
            
            var hasOptional = e.session.tasks.some(function(n){ 
                return n.$options.optional;
            });
            
            sessions.push(e.session);
            
            if (e.session.introduction || hasOptional) {
                draw();
                
                if (!plugin.visible) {
                    plugin.startPage = e.session.introduction ? intro : overview;
                    plugin.show(true, { queue: false });
                }
                else {
                    if (plugin.startPage == plugin.activePage) {
                        if (e.session.introduction) {
                            if (plugin.activePage != intro)
                                plugin.previous();
                            
                            updateIntro();
                        }
                        
                        updatePackages();
                    }
                    else {
                        sessions.remove(e.session);
                        
                        plugin.once("hide", function(){
                            beforeStart(e);
                        });
                        
                        return;
                    }
                }
            }
            else if (plugin.visible) {
                updatePackages();
            }
            else return;
            
            return false;
        }
        
        var drawn;
        function draw(){
            if (drawn) return;
            drawn = true;
            
            ui.insertCss(require("text!./style.css"), options.staticPrefix, plugin);
            
            // Page Intro - displays intro texts
            intro = new WizardPage({ name: "intro" }, plugin);
            intro.on("draw", function(e) {
                ui.insertHtml(e.html, 
                    require("text!./pages/intro.html"), intro);
            });
            intro.on("show", function(){
                updateIntro();
            })
            
            // Page Overview - givs an overview of the components to install
            overview = new WizardPage({ name: "overview" }, plugin);
            overview.on("draw", function(e) {
                ui.insertHtml(e.html, 
                    require("text!./pages/overview.html"), overview);
                
                datagrid = new Datagrid({
                    container: e.html.querySelector("blockquote"),
                    enableCheckboxes: true,
                    
                    columns : [
                        {
                            caption: "Name",
                            value: "name",
                            width: "35%",
                            type: "tree"
                        }, 
                        {
                            caption: "Description",
                            value: "description",
                            width: "65%"
                        }
                    ],
                    
                    getClassName: function(node){
                        return !node.optional ? "required" : "";
                    }
                
                    // getIconHTML: function(node) {
                    //     var icon = node.isFolder ? "folder" : "default";
                    //     if (node.status === "loading") icon = "loading";
                    //     return "<span class='ace_tree-icon " + icon + "'></span>";
                    // }
                }, plugin);
                
                function updateParents(nodes){
                    var parents = {}, toChildren = {};
                    nodes.forEach(function(n){ 
                        if (!n.parent.label) { // Root
                            toChildren[n.label] = true;
                            parents[n.label] = n;
                        }
                        else if (!n.optional)
                            n.isChecked = true;
                        else
                            parents[n.parent.label] = n.parent;
                    });
                    
                    Object.keys(parents).forEach(function(label){
                        var parent = parents[label];
                        
                        if (toChildren[label]) {
                            var all = true;
                            var hasUnchecked = parent.items.some(function(n){ 
                                return nodes.indexOf(n) == -1 && !n.isChecked 
                            });
                            if (hasUnchecked) parent.isChecked = true;
                            
                            parent.items.forEach(function(n){
                                if (!n.optional) all = false;
                                else n.isChecked = parent.isChecked ? true : false;
                            });
                            if (!all && !parent.isChecked)
                                parent.isChecked = -1;
                            return;
                        }
                        
                        var state = 0;
                        parent.items.forEach(function(n){
                            if (n.isChecked) state++;
                        });
                        if (state == parent.items.length)
                            parent.isChecked = true;
                        else
                            parent.isChecked = state ? -1 : false;
                    });
                    
                    if (getSelectedSessions().length === 0) {
                        plugin.showFinish = true;
                        plugin.showNext = false;
                    }
                    else {
                        plugin.showFinish = false;
                        plugin.showNext = true;
                    }
                }
                
                datagrid.on("check", updateParents);
                datagrid.on("uncheck", updateParents);
            });
            overview.on("show", function(){
                updatePackages();
            });
            
            // Page Execute - Show Log Output & Checkbox
            execute = new WizardPage({ name: "execute" }, plugin);
            execute.on("draw", function(e) {
                var div = e.html;
                ui.insertHtml(div, require("text!./pages/execute.html"), execute);
                
                logDiv = div.querySelector(".log");
                spinner = div.querySelector(".progress");
                
                var cb = div.querySelector("#details");
                cb.addEventListener("click", function(){
                    if (cb.checked) {
                        logDiv.className = "log details";
                    }
                    else {
                        logDiv.className = "log";
                    }
                });
                
                plugin.addOther(function(){
                    div.innerHTML = "";
                    div.parentNode.removeChild(div);
                });
            });
            
            // Page Complete - The installer has finished
            complete = new WizardPage({ name: "complete" }, plugin);
            complete.on("draw", function(e) {
                ui.insertHtml(e.html, require("text!./pages/complete.html"), complete);
                setCompleteMessage();
                plugin.showPrevious = false;
                plugin.showFinish = true;
            });
            
            // plugin.on("previous", function(e) {
            //     var page = e.activePage;
            // });
            
            plugin.on("next", function(e) {
                var page = e.activePage;
                if (page.name == "intro") {
                    return overview;
                }
                else if (page.name == "overview") {
                    setTimeout(start);
                    return execute;
                }
                else if (page.name == "execute") {
                    plugin.showFinish = true;
                    plugin.showPrevious = false;
                    plugin.showNext = false;
                    return complete;
                }
            });
            
            plugin.on("cancel", function(e) {
                if (e.activePage.name == "execute") {
                    aborting = true;
                    
                    setCompleteMessage("Installation Aborted",
                        require("text!./install/aborted.html"));
                    
                    plugin.gotoPage(complete);
                    plugin.showCancel = false;
                        
                    executeList.forEach(function(session){
                        if (session.executing)
                            session.abort();
                    });
                }
            });
            
            plugin.startPage = intro;
        }
        
        /***** Methods *****/
        
        function updateIntro(){
            var html = "";
            
            sessions.forEach(function(session){
                html += session.introduction || "";
            });
            intro.container.querySelector("blockquote").innerHTML = html;
        }
        
        function updatePackages(){
            if (!datagrid) return;
            
            var root = { items: [] };
            
            sessions.forEach(function(session){
                var node = { 
                    label: session.package.name, 
                    description: "Version " + session.package.version,
                    session: session,
                    items: [],
                    isOpen: true,
                    isChecked: true
                };
                root.items.push(node);
                
                var optional = false;
                session.tasks.forEach(function(task){
                    if (task.$options) {
                        if (task.$options.isChecked === undefined)
                            task.$options.isChecked = true;
                        node.items.push(task.$options);
                        if (task.$options.optional)
                            optional = true;
                    }
                });
                
                node.optional = optional;
            });
            
            datagrid.setRoot(root);
        }
        
        var lastComplete;
        function setCompleteMessage(title, msg){
            if (!complete.container)
                return (lastComplete = [title, msg]);
                
            complete.container.querySelector("h3").innerHTML = title || lastComplete[0];
            complete.container.querySelector("blockquote").innerHTML = msg || lastComplete[1];
        }
        
        function getSelectedSessions(ignored){
            var sessions = [];
            
            var nodes = datagrid.root.items;
            nodes.filter(function(node){
                var include = typeof node.isChecked == "boolean"
                    ? node.isChecked
                    : true;
                
                var session = node.session;
                if (!include) {
                    if (ignored) ignored.push(session);
                    return false;
                }
                
                session.tasks.forEach(function(task){
                    task.$options.ignore = task.$options.isChecked === false;
                });
                
                sessions.push(session);
            });
            
            return sessions;
        }
        
        function log(msg) {
            (lastOutput || logDiv).insertAdjacentHTML("beforeend", msg);
            logDiv.scrollTop = logDiv.scrollHeight;
        }
        
        function logln(msg) {
            logDiv.insertAdjacentHTML("beforeend", msg + "<br />");
            logDiv.scrollTop = logDiv.scrollHeight;
        }
        
        function start(services, callback) {
            plugin.showCancel = true;
            
            plugin.showPrevious = false;
            plugin.showNext = false;
            
            // Start Installation
            logln("Starting Installation...");
            spinner.style.display = "block";
            
            var aborted = [];
            executeList = getSelectedSessions(aborted);
            sessions = [];
            
            aborted.forEach(function(session){
                session.abort();
            });
            
            async.eachSeries(executeList, function(session, next){
                if (aborting) return next(new Error("Aborted"));
                
                session.on("run", function(){
                    logln("Package " + session.package.name 
                        + " " + session.package.version);
                });
                
                var lastOptions;
                session.on("each", function(e){
                    if (lastOptions != e.options) {
                        lastOptions = e.options;
                        if (e.options.name)
                            logln("Installing " + e.options.name);
                    }
                });
                session.on("data", function(e){
                    log(e.data);
                    
                    // @TODO detect password: input
                });
                
                session.start(next, true);
            }, function(err){
                logDiv.scrollTop = logDiv.scrollHeight;
                
                plugin.showCancel = false;
                
                if (err) {
                    logln("<br />" + err.message + "<br /><br />"
                      + "<span class='error'>One or more errors occured. "
                      + "Please try to resolve them and\n"
                      + "restart Cloud9 or contact support@c9.io.</span>");
                      
                    spinner.style.display = "none";
                    logDiv.className = "log details";
                    
                    if (plugin.activePage.name == "execute")
                        plugin.showPrevious = true;
                }
                else {
                    spinner.style.display = "none";
                    
                    setCompleteMessage("Installation Complete",
                        require("text!./install/success.html")
                            .replace("{{sessions}}", executeList.map(function(s){
                                return s.package.name + " " + s.package.version;
                            }).join("</li><li>")));
                    plugin.showNext = true;
                }
            });
            
            function progress(message, output, error) {
                if (!message.trim()) return;
                if (output) {
                    if (!lastOutput) {
                        log("<div class='output'></div>");
                        lastOutput = logDiv.lastChild;
                    }
                    if (error)
                        message = "<span class='error'>" + message + "</span>";
                    log(message);
                }
                else {
                    lastOutput = null;
                    logln(message);
                }
            }
        }
        
        /***** Lifecycle *****/
        
        plugin.on("draw", function(){
            draw();
        });
        
        plugin.on("load", function(){
            load();
        });
        
        plugin.on("unload", function(){
            aborting = false;
            logDiv = null;
            spinner = null;
            lastOutput = null;
            intro = null;
            overview = null;
            execute = null;
            complete = null;
            drawn = null;
            datagrid = null;
            lastComplete = null;
            sessions = [];
        });
        
        /***** Register and define API *****/
        
        /**
         * Installer for Cloud9
         **/
        plugin.freezePublicAPI({
            
        });
        
        register(null, {
            "installer.gui": plugin
        });
    }
});