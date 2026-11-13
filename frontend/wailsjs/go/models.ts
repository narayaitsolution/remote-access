export namespace main {
	
	export class ProfileView {
	    id: string;
	    name: string;
	    host: string;
	    port: number;
	    user: string;
	    hasPassword: boolean;
	    tmuxSession: string;
	
	    static createFrom(source: any = {}) {
	        return new ProfileView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.user = source["user"];
	        this.hasPassword = source["hasPassword"];
	        this.tmuxSession = source["tmuxSession"];
	    }
	}
	export class Settings {
	    fontFamily: string;
	    fontSize: number;
	    scrollback: number;
	    copyOnSelect: boolean;
	    sidebarVisible: boolean;
	    sidebarWidth: number;
	    sidebarFollow: boolean;
	    keepaliveSeconds: number;
	    tmuxMouse: boolean;
	    downloadDir: string;
	    keys: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.fontFamily = source["fontFamily"];
	        this.fontSize = source["fontSize"];
	        this.scrollback = source["scrollback"];
	        this.copyOnSelect = source["copyOnSelect"];
	        this.sidebarVisible = source["sidebarVisible"];
	        this.sidebarWidth = source["sidebarWidth"];
	        this.sidebarFollow = source["sidebarFollow"];
	        this.keepaliveSeconds = source["keepaliveSeconds"];
	        this.tmuxMouse = source["tmuxMouse"];
	        this.downloadDir = source["downloadDir"];
	        this.keys = source["keys"];
	    }
	}
	export class AppState {
	    settings: Settings;
	    profiles: ProfileView[];
	    configPath: string;
	    configError: string;
	
	    static createFrom(source: any = {}) {
	        return new AppState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.settings = this.convertValues(source["settings"], Settings);
	        this.profiles = this.convertValues(source["profiles"], ProfileView);
	        this.configPath = source["configPath"];
	        this.configError = source["configError"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class FileEntry {
	    name: string;
	    size: number;
	    mode: string;
	    modTime: number;
	    isDir: boolean;
	    isLink: boolean;
	
	    static createFrom(source: any = {}) {
	        return new FileEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.size = source["size"];
	        this.mode = source["mode"];
	        this.modTime = source["modTime"];
	        this.isDir = source["isDir"];
	        this.isLink = source["isLink"];
	    }
	}
	export class DirListing {
	    path: string;
	    entries: FileEntry[];
	
	    static createFrom(source: any = {}) {
	        return new DirListing(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.entries = this.convertValues(source["entries"], FileEntry);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class ProfileInput {
	    id: string;
	    name: string;
	    host: string;
	    port: number;
	    user: string;
	    password: string;
	    savePassword: boolean;
	    keepPassword: boolean;
	    tmuxSession: string;
	
	    static createFrom(source: any = {}) {
	        return new ProfileInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.user = source["user"];
	        this.password = source["password"];
	        this.savePassword = source["savePassword"];
	        this.keepPassword = source["keepPassword"];
	        this.tmuxSession = source["tmuxSession"];
	    }
	}
	
	export class SessionInfo {
	    cwd: string;
	    tmux: string;
	
	    static createFrom(source: any = {}) {
	        return new SessionInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.cwd = source["cwd"];
	        this.tmux = source["tmux"];
	    }
	}

}

