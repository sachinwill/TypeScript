// Currently we do not want to expose API for build, we should work out the API, and then expose it just like we did for builder/watch
/*@internal*/
namespace ts {
    const minimumDate = new Date(-8640000000000000);
    const maximumDate = new Date(8640000000000000);

    export interface BuildHost {
        verbose(diag: DiagnosticMessage, ...args: string[]): void;
        error(diag: DiagnosticMessage, ...args: string[]): void;
        errorDiagnostic(diag: Diagnostic): void;
        message(diag: DiagnosticMessage, ...args: string[]): void;
    }

    type Mapper = ReturnType<typeof createDependencyMapper>;
    interface DependencyGraph {
        buildQueue: ResolvedConfigFileName[];
        dependencyMap: Mapper;
    }

    export interface BuildOptions {
        dry?: boolean;
        force?: boolean;
        verbose?: boolean;
        /*@internal*/ clean?: boolean;
        /*@internal*/ watch?: boolean;
        /*@internal*/ help?: boolean;
        preserveWatchOutput?: boolean;
    }

    enum BuildResultFlags {
        None = 0,

        /**
         * No errors of any kind occurred during build
         */
        Success = 1 << 0,
        /**
         * None of the .d.ts files emitted by this build were
         * different from the existing files on disk
         */
        DeclarationOutputUnchanged = 1 << 1,

        ConfigFileErrors = 1 << 2,
        SyntaxErrors = 1 << 3,
        TypeErrors = 1 << 4,
        DeclarationEmitErrors = 1 << 5,

        AnyErrors = ConfigFileErrors | SyntaxErrors | TypeErrors | DeclarationEmitErrors
    }

    export enum UpToDateStatusType {
        Unbuildable,
        UpToDate,
        /**
         * The project appears out of date because its upstream inputs are newer than its outputs,
         * but all of its outputs are actually newer than the previous identical outputs of its (.d.ts) inputs.
         * This means we can Pseudo-build (just touch timestamps), as if we had actually built this project.
         */
        UpToDateWithUpstreamTypes,
        OutputMissing,
        OutOfDateWithSelf,
        OutOfDateWithUpstream,
        UpstreamOutOfDate,
        UpstreamBlocked,

        /**
         * Projects with no outputs (i.e. "solution" files)
         */
        ContainerOnly
    }

    export type UpToDateStatus =
        | Status.Unbuildable
        | Status.UpToDate
        | Status.OutputMissing
        | Status.OutOfDateWithSelf
        | Status.OutOfDateWithUpstream
        | Status.UpstreamOutOfDate
        | Status.UpstreamBlocked
        | Status.ContainerOnly;

    export namespace Status {
        /**
         * The project can't be built at all in its current state. For example,
         * its config file cannot be parsed, or it has a syntax error or missing file
         */
        export interface Unbuildable {
            type: UpToDateStatusType.Unbuildable;
            reason: string;
        }

        /**
         * This project doesn't have any outputs, so "is it up to date" is a meaningless question.
         */
        export interface ContainerOnly {
            type: UpToDateStatusType.ContainerOnly;
        }

        /**
         * The project is up to date with respect to its inputs.
         * We track what the newest input file is.
         */
        export interface UpToDate {
            type: UpToDateStatusType.UpToDate | UpToDateStatusType.UpToDateWithUpstreamTypes;
            newestInputFileTime?: Date;
            newestInputFileName?: string;
            newestDeclarationFileContentChangedTime?: Date;
            newestOutputFileTime?: Date;
            newestOutputFileName?: string;
            oldestOutputFileName?: string;
        }

        /**
         * One or more of the outputs of the project does not exist.
         */
        export interface OutputMissing {
            type: UpToDateStatusType.OutputMissing;
            /**
             * The name of the first output file that didn't exist
             */
            missingOutputFileName: string;
        }

        /**
         * One or more of the project's outputs is older than its newest input.
         */
        export interface OutOfDateWithSelf {
            type: UpToDateStatusType.OutOfDateWithSelf;
            outOfDateOutputFileName: string;
            newerInputFileName: string;
        }

        /**
         * This project depends on an out-of-date project, so shouldn't be built yet
         */
        export interface UpstreamOutOfDate {
            type: UpToDateStatusType.UpstreamOutOfDate;
            upstreamProjectName: string;
        }

        /**
         * This project depends an upstream project with build errors
         */
        export interface UpstreamBlocked {
            type: UpToDateStatusType.UpstreamBlocked;
            upstreamProjectName: string;
        }

        /**
         * One or more of the project's outputs is older than the newest output of
         * an upstream project.
         */
        export interface OutOfDateWithUpstream {
            type: UpToDateStatusType.OutOfDateWithUpstream;
            outOfDateOutputFileName: string;
            newerProjectName: string;
        }
    }

    interface FileMap<T, U extends string = string, V extends Path = Path> {
        setValue(fileName: U, value: T): void;
        getValue(fileName: U): T | undefined;
        hasKey(fileName: U): boolean;
        removeKey(fileName: U): void;
        forEach(action: (value: T, key: V) => void): void;
        getSize(): number;
        clear(): void;
    }

    type ResolvedConfigFilePath = ResolvedConfigFileName & Path;
    type ConfigFileMap<T> = FileMap<T, ResolvedConfigFileName, ResolvedConfigFilePath>;
    type ToResolvedConfigFilePath = (fileName: ResolvedConfigFileName) => ResolvedConfigFilePath;
    type ToPath = (fileName: string) => Path;

    /**
     * A FileMap maintains a normalized-key to value relationship
     */
    function createFileMap<T>(toPath: ToResolvedConfigFilePath): ConfigFileMap<T>;
    function createFileMap<T, U extends string = string, V extends Path = Path>(toPath: ToPath): FileMap<T, U, V>;
    function createFileMap<T, U extends string = string, V extends Path = Path>(toPath: (fileName: U) => V): FileMap<T, U, V> {
        // tslint:disable-next-line:no-null-keyword
        const lookup = createMap<T>();

        return {
            setValue,
            getValue,
            removeKey,
            forEach,
            hasKey,
            getSize,
            clear
        };

        function forEach(action: (value: T, key: V) => void) {
            lookup.forEach(action);
        }

        function hasKey(fileName: U) {
            return lookup.has(toPath(fileName));
        }

        function removeKey(fileName: U) {
            lookup.delete(toPath(fileName));
        }

        function setValue(fileName: U, value: T) {
            lookup.set(toPath(fileName), value);
        }

        function getValue(fileName: U): T | undefined {
            return lookup.get(toPath(fileName));
        }

        function getSize() {
            return lookup.size;
        }

        function clear() {
            lookup.clear();
        }
    }

    function createDependencyMapper(toPath: ToResolvedConfigFilePath) {
        const childToParents = createFileMap<ResolvedConfigFileName[]>(toPath);
        const parentToChildren = createFileMap<ResolvedConfigFileName[]>(toPath);

        function addReference(childConfigFileName: ResolvedConfigFileName, parentConfigFileName: ResolvedConfigFileName): void {
            addEntry(childToParents, childConfigFileName, parentConfigFileName);
            addEntry(parentToChildren, parentConfigFileName, childConfigFileName);
        }

        function getReferencesTo(parentConfigFileName: ResolvedConfigFileName): ResolvedConfigFileName[] {
            return parentToChildren.getValue(parentConfigFileName) || [];
        }

        function getReferencesOf(childConfigFileName: ResolvedConfigFileName): ResolvedConfigFileName[] {
            return childToParents.getValue(childConfigFileName) || [];
        }

        function addEntry(mapToAddTo: typeof childToParents | typeof parentToChildren, key: ResolvedConfigFileName, element: ResolvedConfigFileName) {
            key = normalizePath(key) as ResolvedConfigFileName;
            element = normalizePath(element) as ResolvedConfigFileName;
            let arr = mapToAddTo.getValue(key);
            if (arr === undefined) {
                mapToAddTo.setValue(key, arr = []);
            }
            if (arr.indexOf(element) < 0) {
                arr.push(element);
            }
        }

        return {
            addReference,
            getReferencesTo,
            getReferencesOf,
        };
    }

    function getOutputDeclarationFileName(inputFileName: string, configFile: ParsedCommandLine) {
        const relativePath = getRelativePathFromDirectory(rootDirOfOptions(configFile.options, configFile.options.configFilePath!), inputFileName, /*ignoreCase*/ true);
        const outputPath = resolvePath(configFile.options.declarationDir || configFile.options.outDir || getDirectoryPath(configFile.options.configFilePath!), relativePath);
        return changeExtension(outputPath, Extension.Dts);
    }

    function getOutputJavaScriptFileName(inputFileName: string, configFile: ParsedCommandLine) {
        const relativePath = getRelativePathFromDirectory(rootDirOfOptions(configFile.options, configFile.options.configFilePath!), inputFileName, /*ignoreCase*/ true);
        const outputPath = resolvePath(configFile.options.outDir || getDirectoryPath(configFile.options.configFilePath!), relativePath);
        const newExtension = fileExtensionIs(inputFileName, Extension.Json) ? Extension.Json :
                             fileExtensionIs(inputFileName, Extension.Tsx) && configFile.options.jsx === JsxEmit.Preserve ? Extension.Jsx : Extension.Js;
        return changeExtension(outputPath, newExtension);
    }

    function getOutputFileNames(inputFileName: string, configFile: ParsedCommandLine): ReadonlyArray<string> {
        // outFile is handled elsewhere; .d.ts files don't generate outputs
        if (configFile.options.outFile || configFile.options.out || fileExtensionIs(inputFileName, Extension.Dts)) {
            return emptyArray;
        }

        const outputs: string[] = [];
        const js = getOutputJavaScriptFileName(inputFileName, configFile);
        outputs.push(js);
        if (configFile.options.sourceMap) {
            outputs.push(`${js}.map`);
        }
        if (getEmitDeclarations(configFile.options) && !fileExtensionIs(inputFileName, Extension.Json)) {
            const dts = getOutputDeclarationFileName(inputFileName, configFile);
            outputs.push(dts);
            if (configFile.options.declarationMap) {
                outputs.push(`${dts}.map`);
            }
        }
        return outputs;
    }

    function getOutFileOutputs(project: ParsedCommandLine): ReadonlyArray<string> {
        if (!project.options.outFile) {
            return Debug.fail("outFile must be set");
        }
        const outputs: string[] = [];
        outputs.push(project.options.outFile);
        if (project.options.sourceMap) {
            outputs.push(`${project.options.outFile}.map`);
        }
        if (getEmitDeclarations(project.options)) {
            const dts = changeExtension(project.options.outFile, Extension.Dts);
            outputs.push(dts);
            if (project.options.declarationMap) {
                outputs.push(`${dts}.map`);
            }
        }
        return outputs;
    }

    function rootDirOfOptions(opts: CompilerOptions, configFileName: string) {
        return opts.rootDir || getDirectoryPath(configFileName);
    }

    function newer(date1: Date, date2: Date): Date {
        return date2 > date1 ? date2 : date1;
    }

    function isDeclarationFile(fileName: string) {
        return fileExtensionIs(fileName, Extension.Dts);
    }

    export interface SolutionBuilderHost extends CompilerHost {
        getModifiedTime(fileName: string): Date | undefined;
        setModifiedTime(fileName: string, date: Date): void;
        deleteFile(fileName: string): void;

        reportDiagnostic: DiagnosticReporter; // Technically we want to move it out and allow steps of actions on Solution, but for now just merge stuff in build host here
        reportSolutionBuilderStatus: DiagnosticReporter;
    }

    export interface SolutionBuilderWithWatchHost extends SolutionBuilderHost, WatchHost {
    }

    /**
     * Create a function that reports watch status by writing to the system and handles the formating of the diagnostic
     */
    export function createBuilderStatusReporter(system: System, pretty?: boolean): DiagnosticReporter {
        return diagnostic => {
            let output = pretty ? `[${formatColorAndReset(new Date().toLocaleTimeString(), ForegroundColorEscapeSequences.Grey)}] ` : `${new Date().toLocaleTimeString()} - `;
            output += `${flattenDiagnosticMessageText(diagnostic.messageText, system.newLine)}${system.newLine + system.newLine}`;
            system.write(output);
        };
    }

    export function createSolutionBuilderHost(system = sys, reportDiagnostic?: DiagnosticReporter, reportSolutionBuilderStatus?: DiagnosticReporter) {
        const host = createCompilerHostWorker({}, /*setParentNodes*/ undefined, system) as SolutionBuilderHost;
        host.getModifiedTime = system.getModifiedTime ? path => system.getModifiedTime!(path) : () => undefined;
        host.setModifiedTime = system.setModifiedTime ? (path, date) => system.setModifiedTime!(path, date) : noop;
        host.deleteFile = system.deleteFile ? path => system.deleteFile!(path) : noop;
        host.reportDiagnostic = reportDiagnostic || createDiagnosticReporter(system);
        host.reportSolutionBuilderStatus = reportSolutionBuilderStatus || createBuilderStatusReporter(system);
        return host;
    }

    export function createSolutionBuilderWithWatchHost(system = sys, reportDiagnostic?: DiagnosticReporter, reportSolutionBuilderStatus?: DiagnosticReporter, reportWatchStatus?: WatchStatusReporter) {
        const host = createSolutionBuilderHost(system, reportDiagnostic, reportSolutionBuilderStatus) as SolutionBuilderWithWatchHost;
        const watchHost = createWatchHost(system, reportWatchStatus);
        host.onWatchStatusChange = watchHost.onWatchStatusChange;
        host.watchFile = watchHost.watchFile;
        host.watchDirectory = watchHost.watchDirectory;
        host.setTimeout = watchHost.setTimeout;
        host.clearTimeout = watchHost.clearTimeout;
        return host;
    }

    /**
     * A SolutionBuilder has an immutable set of rootNames that are the "entry point" projects, but
     * can dynamically add/remove other projects based on changes on the rootNames' references
     * TODO: use SolutionBuilderWithWatchHost => watchedSolution
     *  use SolutionBuilderHost => Solution
     */
    export function createSolutionBuilder(host: SolutionBuilderHost, rootNames: ReadonlyArray<string>, defaultOptions: BuildOptions) {
        const hostWithWatch = host as SolutionBuilderWithWatchHost;
        const currentDirectory = host.getCurrentDirectory();
        const getCanonicalFileName = createGetCanonicalFileName(host.useCaseSensitiveFileNames());
        const parseConfigFileHost = parseConfigHostFromCompilerHost(host);

        // State of the solution
        let options = defaultOptions;
        type ConfigFileCacheEntry = ParsedCommandLine | Diagnostic;
        const configFileCache = createFileMap<ConfigFileCacheEntry>(toPath);
        /** Map from output file name to its pre-build timestamp */
        const unchangedOutputs = createFileMap<Date>(toPath as ToPath);
        /** Map from config file name to up-to-date status */
        const projectStatus = createFileMap<UpToDateStatus>(toPath);
        const missingRoots = createMap<true>();

        // Watch state
        // TODO(shkamat): this should be really be diagnostics but thats for later time
        const diagnostics = createFileMap<number>(toPath);
        const projectPendingBuild = createFileMap<ConfigFileProgramReloadLevel>(toPath);
        const invalidatedProjectQueue = [] as ResolvedConfigFileName[];
        let nextProjectToBuild = 0;
        let timerToBuildInvalidatedProject: any;
        let reportFileChangeDetected = false;

        // Watches for the solution
        const existingWatchersForWildcards = createFileMap<Map<WildcardDirectoryWatcher>>(toPath);

        return {
            buildAllProjects,
            getUpToDateStatus,
            getUpToDateStatusOfFile,
            cleanAllProjects,
            resetBuildContext,
            getBuildGraph,

            invalidateProject,
            buildInvalidatedProject,

            resolveProjectName,

            startWatching
        };

        function toPath(fileName: ResolvedConfigFileName): ResolvedConfigFilePath;
        function toPath(fileName: string): Path;
        function toPath(fileName: string) {
            return ts.toPath(fileName, currentDirectory, getCanonicalFileName);
        }

        function resetBuildContext(opts = defaultOptions) {
            options = opts;
            configFileCache.clear();
            unchangedOutputs.clear();
            projectStatus.clear();
            missingRoots.clear();

            diagnostics.clear();
            projectPendingBuild.clear();
            invalidatedProjectQueue.length = 0;
            nextProjectToBuild = 0;
            if (timerToBuildInvalidatedProject) {
                clearTimeout(timerToBuildInvalidatedProject);
                timerToBuildInvalidatedProject = undefined;
            }
            reportFileChangeDetected = false;
            existingWatchersForWildcards.forEach(wildCardWatches => clearMap(wildCardWatches, closeFileWatcherOf));
        }

        function isParsedCommandLine(entry: ConfigFileCacheEntry): entry is ParsedCommandLine {
            return !!(entry as ParsedCommandLine).options;
        }

        function parseConfigFile(configFilePath: ResolvedConfigFileName): ParsedCommandLine | undefined {
            const value = configFileCache.getValue(configFilePath);
            if (value) {
                return isParsedCommandLine(value) ? value : undefined;
            }

            let diagnostic: Diagnostic | undefined;
            parseConfigFileHost.onUnRecoverableConfigFileDiagnostic = d => diagnostic = d;
            const parsed = getParsedCommandLineOfConfigFile(configFilePath, {}, parseConfigFileHost);
            parseConfigFileHost.onUnRecoverableConfigFileDiagnostic = noop;
            configFileCache.setValue(configFilePath, parsed || diagnostic!);
            return parsed;
        }

        function reportStatus(message: DiagnosticMessage, ...args: string[]) {
            host.reportSolutionBuilderStatus(createCompilerDiagnostic(message, ...args));
        }

        function storeErrors(proj: ResolvedConfigFileName, diagnostics: ReadonlyArray<Diagnostic>) {
            if (options.watch) {
                storeErrorSummary(proj, diagnostics.filter(diagnostic => diagnostic.category === DiagnosticCategory.Error).length);
            }
        }

        function storeErrorSummary(proj: ResolvedConfigFileName, errorCount: number) {
            if (options.watch) {
                diagnostics.setValue(proj, errorCount);
            }
        }

        function reportWatchStatus(message: DiagnosticMessage, ...args: (string | number | undefined)[]) {
            if (hostWithWatch.onWatchStatusChange) {
                hostWithWatch.onWatchStatusChange(createCompilerDiagnostic(message, ...args), host.getNewLine(), { preserveWatchOutput: options.preserveWatchOutput });
            }
        }

        function startWatching() {
            const graph = getGlobalDependencyGraph()!;
            if (!graph.buildQueue) {
                // Everything is broken - we don't even know what to watch. Give up.
                return;
            }

            for (const resolved of graph.buildQueue) {
                const cfg = parseConfigFile(resolved);
                if (cfg) {
                    // Watch this file
                    hostWithWatch.watchFile(resolved, () => {
                        configFileCache.removeKey(resolved);
                        invalidateProjectAndScheduleBuilds(resolved, ConfigFileProgramReloadLevel.Full);
                    });

                    // Update watchers for wildcard directories
                    if (cfg.configFileSpecs) {
                        const existingWatches = existingWatchersForWildcards.getValue(resolved);
                        let newWatches: Map<WildcardDirectoryWatcher> | undefined;
                        if (!existingWatches) {
                            newWatches = createMap();
                            existingWatchersForWildcards.setValue(resolved, newWatches);
                        }
                        updateWatchingWildcardDirectories(existingWatches || newWatches!, createMapFromTemplate(cfg.configFileSpecs.wildcardDirectories), (dir, flags) => {
                            return hostWithWatch.watchDirectory(dir, fileOrDirectory => {
                                const fileOrDirectoryPath = toPath(fileOrDirectory);
                                if (fileOrDirectoryPath !== toPath(dir) && hasExtension(fileOrDirectoryPath) && !isSupportedSourceFileName(fileOrDirectory, cfg.options)) {
                                    // writeLog(`Project: ${configFileName} Detected file add/remove of non supported extension: ${fileOrDirectory}`);
                                    return;
                                }

                                if (isOutputFile(fileOrDirectory, cfg)) {
                                    // writeLog(`${fileOrDirectory} is output file`);
                                    return;
                                }

                                invalidateProjectAndScheduleBuilds(resolved, ConfigFileProgramReloadLevel.Partial);
                            }, !!(flags & WatchDirectoryFlags.Recursive));
                        });
                    }

                    // Watch input files
                    for (const input of cfg.fileNames) {
                        hostWithWatch.watchFile(input, () => {
                            invalidateProjectAndScheduleBuilds(resolved, ConfigFileProgramReloadLevel.None);
                        });
                    }
                }
            }

        }

        function isOutputFile(fileName: string, configFile: ParsedCommandLine) {
            if (configFile.options.noEmit) return false;

            // ts or tsx files are not output
            if (!fileExtensionIs(fileName, Extension.Dts) &&
                (fileExtensionIs(fileName, Extension.Ts) || fileExtensionIs(fileName, Extension.Tsx))) {
                return false;
            }

            // If options have --outFile or --out, check if its that
            const out = configFile.options.outFile || configFile.options.out;
            if (out && (isSameFile(fileName, out) || isSameFile(fileName, removeFileExtension(out) + Extension.Dts))) {
                return true;
            }

            // If declarationDir is specified, return if its a file in that directory
            if (configFile.options.declarationDir && containsPath(configFile.options.declarationDir, fileName, currentDirectory, !host.useCaseSensitiveFileNames())) {
                return true;
            }

            // If --outDir, check if file is in that directory
            if (configFile.options.outDir && containsPath(configFile.options.outDir, fileName, currentDirectory, !host.useCaseSensitiveFileNames())) {
                return true;
            }

            return !forEach(configFile.fileNames, inputFile => isSameFile(fileName, inputFile));
        }

        function isSameFile(file1: string, file2: string) {
            return comparePaths(file1, file2, currentDirectory, !host.useCaseSensitiveFileNames()) === Comparison.EqualTo;
        }

        function invalidateProjectAndScheduleBuilds(resolved: ResolvedConfigFileName, reloadLevel: ConfigFileProgramReloadLevel) {
            reportFileChangeDetected = true;
            invalidateProject(resolved, reloadLevel);
            scheduleBuildInvalidatedProject();
        }

        function getUpToDateStatusOfFile(configFileName: ResolvedConfigFileName): UpToDateStatus {
            return getUpToDateStatus(parseConfigFile(configFileName));
        }

        function getBuildGraph(configFileNames: ReadonlyArray<string>) {
            const resolvedNames: ResolvedConfigFileName[] | undefined = resolveProjectNames(configFileNames);
            if (resolvedNames === undefined) return undefined;

            return createDependencyGraph(resolvedNames);
        }

        function getGlobalDependencyGraph() {
            return getBuildGraph(rootNames);
        }

        function getUpToDateStatus(project: ParsedCommandLine | undefined): UpToDateStatus {
            if (project === undefined) {
                return { type: UpToDateStatusType.Unbuildable, reason: "File deleted mid-build" };
            }

            const prior = projectStatus.getValue(project.options.configFilePath as ResolvedConfigFilePath);
            if (prior !== undefined) {
                return prior;
            }

            const actual = getUpToDateStatusWorker(project);
            projectStatus.setValue(project.options.configFilePath as ResolvedConfigFilePath, actual);
            return actual;
        }

        function getUpToDateStatusWorker(project: ParsedCommandLine): UpToDateStatus {
            let newestInputFileName: string = undefined!;
            let newestInputFileTime = minimumDate;
            // Get timestamps of input files
            for (const inputFile of project.fileNames) {
                if (!host.fileExists(inputFile)) {
                    return {
                        type: UpToDateStatusType.Unbuildable,
                        reason: `${inputFile} does not exist`
                    };
                }

                const inputTime = host.getModifiedTime(inputFile) || missingFileModifiedTime;
                if (inputTime > newestInputFileTime) {
                    newestInputFileName = inputFile;
                    newestInputFileTime = inputTime;
                }
            }

            // Collect the expected outputs of this project
            const outputs = getAllProjectOutputs(project);

            if (outputs.length === 0) {
                return {
                    type: UpToDateStatusType.ContainerOnly
                };
            }

            // Now see if all outputs are newer than the newest input
            let oldestOutputFileName = "(none)";
            let oldestOutputFileTime = maximumDate;
            let newestOutputFileName = "(none)";
            let newestOutputFileTime = minimumDate;
            let missingOutputFileName: string | undefined;
            let newestDeclarationFileContentChangedTime = minimumDate;
            let isOutOfDateWithInputs = false;
            for (const output of outputs) {
                // Output is missing; can stop checking
                // Don't immediately return because we can still be upstream-blocked, which is a higher-priority status
                if (!host.fileExists(output)) {
                    missingOutputFileName = output;
                    break;
                }

                const outputTime = host.getModifiedTime(output) || missingFileModifiedTime;
                if (outputTime < oldestOutputFileTime) {
                    oldestOutputFileTime = outputTime;
                    oldestOutputFileName = output;
                }

                // If an output is older than the newest input, we can stop checking
                // Don't immediately return because we can still be upstream-blocked, which is a higher-priority status
                if (outputTime < newestInputFileTime) {
                    isOutOfDateWithInputs = true;
                    break;
                }

                if (outputTime > newestOutputFileTime) {
                    newestOutputFileTime = outputTime;
                    newestOutputFileName = output;
                }

                // Keep track of when the most recent time a .d.ts file was changed.
                // In addition to file timestamps, we also keep track of when a .d.ts file
                // had its file touched but not had its contents changed - this allows us
                // to skip a downstream typecheck
                if (isDeclarationFile(output)) {
                    const unchangedTime = unchangedOutputs.getValue(output);
                    if (unchangedTime !== undefined) {
                        newestDeclarationFileContentChangedTime = newer(unchangedTime, newestDeclarationFileContentChangedTime);
                    }
                    else {
                        const outputModifiedTime = host.getModifiedTime(output) || missingFileModifiedTime;
                        newestDeclarationFileContentChangedTime = newer(newestDeclarationFileContentChangedTime, outputModifiedTime);
                    }
                }
            }

            let pseudoUpToDate = false;
            let usesPrepend = false;
            let upstreamChangedProject: string | undefined;
            if (project.projectReferences) {
                for (const ref of project.projectReferences) {
                    usesPrepend = usesPrepend || !!(ref.prepend);
                    const resolvedRef = resolveProjectReferencePath(host, ref);
                    const refStatus = getUpToDateStatus(parseConfigFile(resolvedRef));

                    // An upstream project is blocked
                    if (refStatus.type === UpToDateStatusType.Unbuildable) {
                        return {
                            type: UpToDateStatusType.UpstreamBlocked,
                            upstreamProjectName: ref.path
                        };
                    }

                    // If the upstream project is out of date, then so are we (someone shouldn't have asked, though?)
                    if (refStatus.type !== UpToDateStatusType.UpToDate) {
                        return {
                            type: UpToDateStatusType.UpstreamOutOfDate,
                            upstreamProjectName: ref.path
                        };
                    }

                    // If the upstream project's newest file is older than our oldest output, we
                    // can't be out of date because of it
                    if (refStatus.newestInputFileTime && refStatus.newestInputFileTime <= oldestOutputFileTime) {
                        continue;
                    }

                    // If the upstream project has only change .d.ts files, and we've built
                    // *after* those files, then we're "psuedo up to date" and eligible for a fast rebuild
                    if (refStatus.newestDeclarationFileContentChangedTime && refStatus.newestDeclarationFileContentChangedTime <= oldestOutputFileTime) {
                        pseudoUpToDate = true;
                        upstreamChangedProject = ref.path;
                        continue;
                    }

                    // We have an output older than an upstream output - we are out of date
                    Debug.assert(oldestOutputFileName !== undefined, "Should have an oldest output filename here");
                    return {
                        type: UpToDateStatusType.OutOfDateWithUpstream,
                        outOfDateOutputFileName: oldestOutputFileName,
                        newerProjectName: ref.path
                    };
                }
            }

            if (missingOutputFileName !== undefined) {
                return {
                    type: UpToDateStatusType.OutputMissing,
                    missingOutputFileName
                };
            }

            if (isOutOfDateWithInputs) {
                return {
                    type: UpToDateStatusType.OutOfDateWithSelf,
                    outOfDateOutputFileName: oldestOutputFileName,
                    newerInputFileName: newestInputFileName
                };
            }

            if (usesPrepend && pseudoUpToDate) {
                return {
                    type: UpToDateStatusType.OutOfDateWithUpstream,
                    outOfDateOutputFileName: oldestOutputFileName,
                    newerProjectName: upstreamChangedProject!
                };
            }

            // Up to date
            return {
                type: pseudoUpToDate ? UpToDateStatusType.UpToDateWithUpstreamTypes : UpToDateStatusType.UpToDate,
                newestDeclarationFileContentChangedTime,
                newestInputFileTime,
                newestOutputFileTime,
                newestInputFileName,
                newestOutputFileName,
                oldestOutputFileName
            };
        }

        function invalidateProject(configFileName: string, reloadLevel?: ConfigFileProgramReloadLevel) {
            const resolved = resolveProjectName(configFileName);
            if (resolved === undefined) {
                // If this was a rootName, we need to track it as missing.
                // Otherwise we can just ignore it and have it possibly surface as an error in any downstream projects,
                // if they exist

                // TODO: do those things
                return;
            }

            projectStatus.removeKey(resolved);
            if (options.watch) {
                diagnostics.removeKey(resolved);
            }

            if (addProjToQueue(resolved, reloadLevel)) {
                const dependencyGraph = getGlobalDependencyGraph();
                if (dependencyGraph) {
                    queueBuildForDownstreamReferences(resolved, dependencyGraph);
                }
            }
        }

        /**
         * return true if new addition
         */
        function addProjToQueue(proj: ResolvedConfigFileName, reloadLevel?: ConfigFileProgramReloadLevel) {
            const value = projectPendingBuild.getValue(proj);
            if (value === undefined) {
                projectPendingBuild.setValue(proj, reloadLevel || ConfigFileProgramReloadLevel.None);
                invalidatedProjectQueue.push(proj);
                return true;
            }

            if (value < (reloadLevel || ConfigFileProgramReloadLevel.None)) {
                projectPendingBuild.setValue(proj, reloadLevel || ConfigFileProgramReloadLevel.None);
            }
        }

        function getNextInvalidatedProject() {
            if (nextProjectToBuild < invalidatedProjectQueue.length) {
                const project = invalidatedProjectQueue[nextProjectToBuild];
                nextProjectToBuild++;
                const reloadLevel = projectPendingBuild.getValue(project)!;
                projectPendingBuild.removeKey(project);
                if (!projectPendingBuild.getSize()) {
                    invalidatedProjectQueue.length = 0;
                    nextProjectToBuild = 0;
                }
                return { project, reloadLevel };
            }
        }

        function hasPendingInvalidatedProjects() {
            return !!projectPendingBuild.getSize();
        }

        // Mark all downstream projects of this one needing to be built "later"
        function queueBuildForDownstreamReferences(root: ResolvedConfigFileName, dependencyGraph: DependencyGraph) {
            const deps = dependencyGraph.dependencyMap.getReferencesTo(root);
            for (const ref of deps) {
                // Can skip circular references
                if (addProjToQueue(ref)) {
                    queueBuildForDownstreamReferences(ref, dependencyGraph);
                }
            }
        }

        function scheduleBuildInvalidatedProject() {
            if (!hostWithWatch.setTimeout || !hostWithWatch.clearTimeout) {
                return;
            }
            if (timerToBuildInvalidatedProject) {
                hostWithWatch.clearTimeout(timerToBuildInvalidatedProject);
            }
            timerToBuildInvalidatedProject = hostWithWatch.setTimeout(buildInvalidatedProject, 250);
        }

        function buildInvalidatedProject() {
            timerToBuildInvalidatedProject = undefined;
            if (reportFileChangeDetected) {
                reportFileChangeDetected = false;
                reportWatchStatus(Diagnostics.File_change_detected_Starting_incremental_compilation);
            }
            const buildProject = getNextInvalidatedProject();
            if (buildProject) {
                buildSingleInvalidatedProject(buildProject.project, buildProject.reloadLevel);
                if (hasPendingInvalidatedProjects()) {
                    if (!timerToBuildInvalidatedProject) {
                        scheduleBuildInvalidatedProject();
                    }
                }
                else {
                    reportErrorSummary();
                }
            }
        }

        function reportErrorSummary() {
            if (options.watch) {
                let totalErrors = 0;
                diagnostics.forEach(singleProjectErrors => totalErrors += singleProjectErrors);
                reportWatchStatus(totalErrors === 1 ? Diagnostics.Found_1_error_Watching_for_file_changes : Diagnostics.Found_0_errors_Watching_for_file_changes, totalErrors);
            }
        }

        function buildSingleInvalidatedProject(project: ResolvedConfigFileName, reloadLevel: ConfigFileProgramReloadLevel) {
            // TODO:: handle this in better way later

            const resolved = resolveProjectName(project);
            if (!resolved) return; // ??
            const proj = parseConfigFile(resolved);
            if (!proj) return; // ?
            // TODO:: If full reload , update watch for wild cards
            // TODO:: If full or partial reload, update watch for input files

            if (reloadLevel === ConfigFileProgramReloadLevel.Partial) {
                // Update file names
                const result = getFileNamesFromConfigSpecs(proj.configFileSpecs!, getDirectoryPath(project), proj.options, parseConfigFileHost);
                if (result.fileNames.length !== 0) {
                    filterMutate(proj.errors, error => !isErrorNoInputFiles(error));
                }
                else if (!proj.configFileSpecs!.filesSpecs && !some(proj.errors, isErrorNoInputFiles)) {
                    proj.errors.push(getErrorForNoInputFiles(proj.configFileSpecs!, resolved));
                }
                proj.fileNames = result.fileNames;
            }

            const status = getUpToDateStatus(proj);
            verboseReportProjectStatus(project, status);

            if (status.type === UpToDateStatusType.UpstreamBlocked) {
                if (options.verbose) reportStatus(Diagnostics.Skipping_build_of_project_0_because_its_dependency_1_has_errors, resolved, status.upstreamProjectName);
                return;
            }

            buildSingleProject(project);
        }

        function createDependencyGraph(roots: ResolvedConfigFileName[]): DependencyGraph | undefined {
            const temporaryMarks: { [path: string]: true } = {};
            const permanentMarks: { [path: string]: true } = {};
            const circularityReportStack: string[] = [];
            const buildOrder: ResolvedConfigFileName[] = [];
            const graph = createDependencyMapper(toPath);

            let hadError = false;

            for (const root of roots) {
                visit(root);
            }

            if (hadError) {
                return undefined;
            }

            return {
                buildQueue: buildOrder,
                dependencyMap: graph
            };

            function visit(projPath: ResolvedConfigFileName, inCircularContext = false) {
                // Already visited
                if (permanentMarks[projPath]) return;
                // Circular
                if (temporaryMarks[projPath]) {
                    if (!inCircularContext) {
                        hadError = true;
                        // TODO(shkamat): Account for this error
                        reportStatus(Diagnostics.Project_references_may_not_form_a_circular_graph_Cycle_detected_Colon_0, circularityReportStack.join("\r\n"));
                        return;
                    }
                }

                temporaryMarks[projPath] = true;
                circularityReportStack.push(projPath);
                const parsed = parseConfigFile(projPath);
                if (parsed === undefined) {
                    hadError = true;
                    return;
                }
                if (parsed.projectReferences) {
                    for (const ref of parsed.projectReferences) {
                        const resolvedRefPath = resolveProjectName(ref.path);
                        if (resolvedRefPath === undefined) {
                            hadError = true;
                            break;
                        }
                        visit(resolvedRefPath, inCircularContext || ref.circular);
                        graph.addReference(projPath, resolvedRefPath);
                    }
                }

                circularityReportStack.pop();
                permanentMarks[projPath] = true;
                buildOrder.push(projPath);
            }
        }

        function buildSingleProject(proj: ResolvedConfigFileName): BuildResultFlags {
            if (options.dry) {
                reportStatus(Diagnostics.A_non_dry_build_would_build_project_0, proj);
                return BuildResultFlags.Success;
            }

            if (options.verbose) reportStatus(Diagnostics.Building_project_0, proj);

            let resultFlags = BuildResultFlags.None;
            resultFlags |= BuildResultFlags.DeclarationOutputUnchanged;

            const configFile = parseConfigFile(proj);
            if (!configFile) {
                // Failed to read the config file
                resultFlags |= BuildResultFlags.ConfigFileErrors;
                host.reportDiagnostic(configFileCache.getValue(proj) as Diagnostic);
                storeErrorSummary(proj, 1);
                projectStatus.setValue(proj, { type: UpToDateStatusType.Unbuildable, reason: "Config file errors" });
                return resultFlags;
            }

            if (configFile.fileNames.length === 0) {
                // Nothing to build - must be a solution file, basically
                return BuildResultFlags.None;
            }

            const programOptions: CreateProgramOptions = {
                projectReferences: configFile.projectReferences,
                host,
                rootNames: configFile.fileNames,
                options: configFile.options,
                configFileParsingDiagnostics: configFile.errors
            };
            const program = createProgram(programOptions);

            // Don't emit anything in the presence of syntactic errors or options diagnostics
            const syntaxDiagnostics = [
                ...program.getOptionsDiagnostics(),
                ...program.getConfigFileParsingDiagnostics(),
                ...program.getSyntacticDiagnostics()];
            if (syntaxDiagnostics.length) {
                resultFlags |= BuildResultFlags.SyntaxErrors;
                for (const diag of syntaxDiagnostics) {
                    host.reportDiagnostic(diag);
                }
                storeErrors(proj, syntaxDiagnostics);
                projectStatus.setValue(proj, { type: UpToDateStatusType.Unbuildable, reason: "Syntactic errors" });
                return resultFlags;
            }

            // Don't emit .d.ts if there are decl file errors
            if (getEmitDeclarations(program.getCompilerOptions())) {
                const declDiagnostics = program.getDeclarationDiagnostics();
                if (declDiagnostics.length) {
                    resultFlags |= BuildResultFlags.DeclarationEmitErrors;
                    for (const diag of declDiagnostics) {
                        host.reportDiagnostic(diag);
                    }
                    storeErrors(proj, declDiagnostics);
                    projectStatus.setValue(proj, { type: UpToDateStatusType.Unbuildable, reason: "Declaration file errors" });
                    return resultFlags;
                }
            }

            // Same as above but now for semantic diagnostics
            const semanticDiagnostics = program.getSemanticDiagnostics();
            if (semanticDiagnostics.length) {
                resultFlags |= BuildResultFlags.TypeErrors;
                for (const diag of semanticDiagnostics) {
                    host.reportDiagnostic(diag);
                }
                storeErrors(proj, semanticDiagnostics);
                projectStatus.setValue(proj, { type: UpToDateStatusType.Unbuildable, reason: "Semantic errors" });
                return resultFlags;
            }

            let newestDeclarationFileContentChangedTime = minimumDate;
            let anyDtsChanged = false;
            program.emit(/*targetSourceFile*/ undefined, (fileName, content, writeBom, onError) => {
                let priorChangeTime: Date | undefined;

                if (!anyDtsChanged && isDeclarationFile(fileName) && host.fileExists(fileName)) {
                    if (host.readFile(fileName) === content) {
                        // Check for unchanged .d.ts files
                        resultFlags &= ~BuildResultFlags.DeclarationOutputUnchanged;
                        priorChangeTime = host.getModifiedTime(fileName);
                    }
                    else {
                        anyDtsChanged = true;
                    }
                }

                host.writeFile(fileName, content, writeBom, onError, emptyArray);
                if (priorChangeTime !== undefined) {
                    newestDeclarationFileContentChangedTime = newer(priorChangeTime, newestDeclarationFileContentChangedTime);
                    unchangedOutputs.setValue(fileName, priorChangeTime);
                }
            });

            const status: UpToDateStatus = {
                type: UpToDateStatusType.UpToDate,
                newestDeclarationFileContentChangedTime: anyDtsChanged ? maximumDate : newestDeclarationFileContentChangedTime
            };
            projectStatus.setValue(proj, status);
            return resultFlags;
        }

        function updateOutputTimestamps(proj: ParsedCommandLine) {
            if (options.dry) {
                return reportStatus(Diagnostics.A_non_dry_build_would_build_project_0, proj.options.configFilePath!);
            }

            if (options.verbose) {
                reportStatus(Diagnostics.Updating_output_timestamps_of_project_0, proj.options.configFilePath!);
            }

            const now = new Date();
            const outputs = getAllProjectOutputs(proj);
            let priorNewestUpdateTime = minimumDate;
            for (const file of outputs) {
                if (isDeclarationFile(file)) {
                    priorNewestUpdateTime = newer(priorNewestUpdateTime, host.getModifiedTime(file) || missingFileModifiedTime);
                }

                host.setModifiedTime(file, now);
            }

            projectStatus.setValue(proj.options.configFilePath as ResolvedConfigFilePath, { type: UpToDateStatusType.UpToDate, newestDeclarationFileContentChangedTime: priorNewestUpdateTime } as UpToDateStatus);
        }

        function getFilesToClean(configFileNames: ReadonlyArray<ResolvedConfigFileName>): string[] | undefined {
            const resolvedNames: ResolvedConfigFileName[] | undefined = resolveProjectNames(configFileNames);
            if (resolvedNames === undefined) return undefined;

            // Get the same graph for cleaning we'd use for building
            const graph = createDependencyGraph(resolvedNames);
            if (graph === undefined) return undefined;

            const filesToDelete: string[] = [];
            for (const proj of graph.buildQueue) {
                const parsed = parseConfigFile(proj);
                if (parsed === undefined) {
                    // File has gone missing; fine to ignore here
                    continue;
                }
                const outputs = getAllProjectOutputs(parsed);
                for (const output of outputs) {
                    if (host.fileExists(output)) {
                        filesToDelete.push(output);
                    }
                }
            }
            return filesToDelete;
        }

        function getAllProjectsInScope(): ReadonlyArray<ResolvedConfigFileName> | undefined {
            const resolvedNames = resolveProjectNames(rootNames);
            if (resolvedNames === undefined) return undefined;
            const graph = createDependencyGraph(resolvedNames);
            if (graph === undefined) return undefined;
            return graph.buildQueue;
        }

        function cleanAllProjects() {
            const resolvedNames: ReadonlyArray<ResolvedConfigFileName> | undefined = getAllProjectsInScope();
            if (resolvedNames === undefined) {
                reportStatus(Diagnostics.Skipping_clean_because_not_all_projects_could_be_located);
                return ExitStatus.DiagnosticsPresent_OutputsSkipped;
            }

            const filesToDelete = getFilesToClean(resolvedNames);
            if (filesToDelete === undefined) {
                reportStatus(Diagnostics.Skipping_clean_because_not_all_projects_could_be_located);
                return ExitStatus.DiagnosticsPresent_OutputsSkipped;
            }

            if (options.dry) {
                reportStatus(Diagnostics.A_non_dry_build_would_delete_the_following_files_Colon_0, filesToDelete.map(f => `\r\n * ${f}`).join(""));
                return ExitStatus.Success;
            }

            for (const output of filesToDelete) {
                host.deleteFile(output);
            }

            return ExitStatus.Success;
        }

        function resolveProjectName(name: string): ResolvedConfigFileName | undefined {
            const fullPath = resolvePath(host.getCurrentDirectory(), name);
            if (host.fileExists(fullPath)) {
                return fullPath as ResolvedConfigFileName;
            }
            const fullPathWithTsconfig = combinePaths(fullPath, "tsconfig.json");
            if (host.fileExists(fullPathWithTsconfig)) {
                return fullPathWithTsconfig as ResolvedConfigFileName;
            }
            // TODO(shkamat): right now this is accounted as 1 error in config file, but we need to do better
            host.reportDiagnostic(createCompilerDiagnostic(Diagnostics.File_0_not_found, relName(fullPath)));
            return undefined;
        }

        function resolveProjectNames(configFileNames: ReadonlyArray<string>): ResolvedConfigFileName[] | undefined {
            const resolvedNames: ResolvedConfigFileName[] = [];
            for (const name of configFileNames) {
                const resolved = resolveProjectName(name);
                if (resolved === undefined) {
                    return undefined;
                }
                resolvedNames.push(resolved);
            }
            return resolvedNames;
        }

        function buildAllProjects(): ExitStatus {
            if (options.watch) { reportWatchStatus(Diagnostics.Starting_compilation_in_watch_mode); }
            const graph = getGlobalDependencyGraph();
            if (graph === undefined) {
                reportErrorSummary();
                return ExitStatus.DiagnosticsPresent_OutputsSkipped;
            }

            const queue = graph.buildQueue;
            reportBuildQueue(graph);

            let anyFailed = false;
            for (const next of queue) {
                const proj = parseConfigFile(next);
                if (proj === undefined) {
                    anyFailed = true;
                    break;
                }
                const status = getUpToDateStatus(proj);
                verboseReportProjectStatus(next, status);

                const projName = proj.options.configFilePath!;
                if (status.type === UpToDateStatusType.UpToDate && !options.force) {
                    // Up to date, skip
                    if (defaultOptions.dry) {
                        // In a dry build, inform the user of this fact
                        reportStatus(Diagnostics.Project_0_is_up_to_date, projName);
                    }
                    continue;
                }

                if (status.type === UpToDateStatusType.UpToDateWithUpstreamTypes && !options.force) {
                    // Fake build
                    updateOutputTimestamps(proj);
                    continue;
                }

                if (status.type === UpToDateStatusType.UpstreamBlocked) {
                    if (options.verbose) reportStatus(Diagnostics.Skipping_build_of_project_0_because_its_dependency_1_has_errors, projName, status.upstreamProjectName);
                    continue;
                }

                if (status.type === UpToDateStatusType.ContainerOnly) {
                    // Do nothing
                    continue;
                }

                const buildResult = buildSingleProject(next);
                anyFailed = anyFailed || !!(buildResult & BuildResultFlags.AnyErrors);
            }
            reportErrorSummary();
            return anyFailed ? ExitStatus.DiagnosticsPresent_OutputsSkipped : ExitStatus.Success;
        }

        /**
         * Report the build ordering inferred from the current project graph if we're in verbose mode
         */
        function reportBuildQueue(graph: DependencyGraph) {
            if (!options.verbose) return;

            const names: string[] = [];
            for (const name of graph.buildQueue) {
                names.push(name);
            }
            if (options.verbose) reportStatus(Diagnostics.Projects_in_this_build_Colon_0, names.map(s => "\r\n    * " + relName(s)).join(""));
        }

        function relName(path: string): string {
            return convertToRelativePath(path, host.getCurrentDirectory(), f => host.getCanonicalFileName(f));
        }

        /**
         * Report the up-to-date status of a project if we're in verbose mode
         */
        function verboseReportProjectStatus(configFileName: string, status: UpToDateStatus) {
            if (!options.verbose) return;
            return formatUpToDateStatus(configFileName, status, relName, reportStatus);
        }
    }

    export function getAllProjectOutputs(project: ParsedCommandLine): ReadonlyArray<string> {
        if (project.options.outFile) {
            return getOutFileOutputs(project);
        }
        else {
            const outputs: string[] = [];
            for (const inputFile of project.fileNames) {
                outputs.push(...getOutputFileNames(inputFile, project));
            }
            return outputs;
        }
    }

    export function formatUpToDateStatus<T>(configFileName: string, status: UpToDateStatus, relName: (fileName: string) => string, formatMessage: (message: DiagnosticMessage, ...args: string[]) => T) {
        switch (status.type) {
            case UpToDateStatusType.OutOfDateWithSelf:
                return formatMessage(Diagnostics.Project_0_is_out_of_date_because_oldest_output_1_is_older_than_newest_input_2,
                    relName(configFileName),
                    relName(status.outOfDateOutputFileName),
                    relName(status.newerInputFileName));
            case UpToDateStatusType.OutOfDateWithUpstream:
                return formatMessage(Diagnostics.Project_0_is_out_of_date_because_oldest_output_1_is_older_than_newest_input_2,
                    relName(configFileName),
                    relName(status.outOfDateOutputFileName),
                    relName(status.newerProjectName));
            case UpToDateStatusType.OutputMissing:
                return formatMessage(Diagnostics.Project_0_is_out_of_date_because_output_file_1_does_not_exist,
                    relName(configFileName),
                    relName(status.missingOutputFileName));
            case UpToDateStatusType.UpToDate:
                if (status.newestInputFileTime !== undefined) {
                    return formatMessage(Diagnostics.Project_0_is_up_to_date_because_newest_input_1_is_older_than_oldest_output_2,
                        relName(configFileName),
                        relName(status.newestInputFileName || ""),
                        relName(status.oldestOutputFileName || ""));
                }
                // Don't report anything for "up to date because it was already built" -- too verbose
                break;
            case UpToDateStatusType.UpToDateWithUpstreamTypes:
                return formatMessage(Diagnostics.Project_0_is_up_to_date_with_d_ts_files_from_its_dependencies,
                    relName(configFileName));
            case UpToDateStatusType.UpstreamOutOfDate:
                return formatMessage(Diagnostics.Project_0_is_out_of_date_because_its_dependency_1_is_out_of_date,
                    relName(configFileName),
                    relName(status.upstreamProjectName));
            case UpToDateStatusType.UpstreamBlocked:
                return formatMessage(Diagnostics.Project_0_can_t_be_built_because_its_dependency_1_has_errors,
                    relName(configFileName),
                    relName(status.upstreamProjectName));
            case UpToDateStatusType.Unbuildable:
                return formatMessage(Diagnostics.Failed_to_parse_file_0_Colon_1,
                    relName(configFileName),
                    status.reason);
            case UpToDateStatusType.ContainerOnly:
                // Don't report status on "solution" projects
                break;
            default:
                assertType<never>(status);
        }
    }
}
