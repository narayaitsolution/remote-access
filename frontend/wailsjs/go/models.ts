export namespace main {
	
	export class AIProviderInfo {
	    id: string;
	    name: string;
	    installed: boolean;
	    path: string;
	    models: string[];
	    defaultModel: string;
	    kind: string;
	
	    static createFrom(source: any = {}) {
	        return new AIProviderInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.installed = source["installed"];
	        this.path = source["path"];
	        this.models = source["models"];
	        this.defaultModel = source["defaultModel"];
	        this.kind = source["kind"];
	    }
	}
	export class AIProviderInput {
	    id: string;
	    name: string;
	    baseUrl: string;
	    apiKey: string;
	    keepKey: boolean;
	    models: string;
	
	    static createFrom(source: any = {}) {
	        return new AIProviderInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.baseUrl = source["baseUrl"];
	        this.apiKey = source["apiKey"];
	        this.keepKey = source["keepKey"];
	        this.models = source["models"];
	    }
	}
	export class AIProviderView {
	    id: string;
	    name: string;
	    baseUrl: string;
	    hasKey: boolean;
	    models: string[];
	
	    static createFrom(source: any = {}) {
	        return new AIProviderView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.baseUrl = source["baseUrl"];
	        this.hasKey = source["hasKey"];
	        this.models = source["models"];
	    }
	}
	export class ProfileView {
	    id: string;
	    name: string;
	    host: string;
	    port: number;
	    user: string;
	    hasPassword: boolean;
	    authType: string;
	    keyPath: string;
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
	        this.authType = source["authType"];
	        this.keyPath = source["keyPath"];
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
	    aiVisible: boolean;
	    aiWidth: number;
	    aiProvider: string;
	    aiModels: Record<string, string>;
	    setupDone: boolean;
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
	        this.aiVisible = source["aiVisible"];
	        this.aiWidth = source["aiWidth"];
	        this.aiProvider = source["aiProvider"];
	        this.aiModels = source["aiModels"];
	        this.setupDone = source["setupDone"];
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
	export class DepStatus {
	    id: string;
	    name: string;
	    purpose: string;
	    status: string;
	    detail: string;
	    installable: boolean;
	    needsLogin: boolean;
	    manual: string;
	
	    static createFrom(source: any = {}) {
	        return new DepStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.purpose = source["purpose"];
	        this.status = source["status"];
	        this.detail = source["detail"];
	        this.installable = source["installable"];
	        this.needsLogin = source["needsLogin"];
	        this.manual = source["manual"];
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
	export class EditFile {
	    path: string;
	    content: string;
	    stamp: string;
	    size: number;
	    mode: string;
	
	    static createFrom(source: any = {}) {
	        return new EditFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.content = source["content"];
	        this.stamp = source["stamp"];
	        this.size = source["size"];
	        this.mode = source["mode"];
	    }
	}
	
	export class LocalEdit {
	    id: string;
	    sessId: string;
	    remote: string;
	    name: string;
	    app: string;
	    state: string;
	    error: string;
	    lastSync: number;
	
	    static createFrom(source: any = {}) {
	        return new LocalEdit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.sessId = source["sessId"];
	        this.remote = source["remote"];
	        this.name = source["name"];
	        this.app = source["app"];
	        this.state = source["state"];
	        this.error = source["error"];
	        this.lastSync = source["lastSync"];
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
	    authType: string;
	    keyPath: string;
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
	        this.authType = source["authType"];
	        this.keyPath = source["keyPath"];
	        this.tmuxSession = source["tmuxSession"];
	    }
	}
	
	export class SessionInfo {
	    cwd: string;
	    tmux: string;
	    cmd: string;
	
	    static createFrom(source: any = {}) {
	        return new SessionInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.cwd = source["cwd"];
	        this.tmux = source["tmux"];
	        this.cmd = source["cmd"];
	    }
	}

}

