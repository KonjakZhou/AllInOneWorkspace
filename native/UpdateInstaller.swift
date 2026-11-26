import Foundation
import AppKit
import CryptoKit
import Darwin

// trustedUpdateKey is prepended at build time, never taken from the update request.
let fm = FileManager.default
struct Request: Decodable {
    let target: String
    let archive: String
    let manifestPath: String
    let signaturePath: String
    let parentPid: Int32
    let nonce: String
    let stage: String
    let dataDirectory: String
}
struct Asset: Decodable { let name: String; let size: Int; let sha256: String }
struct Manifest: Decodable {
    let schemaVersion: Int; let repository: String; let bundleId: String
    let version: String; let platform: String; let arch: String
    let zip: Asset
}
struct InstallError: Error, CustomStringConvertible { let description: String; init(_ s: String) { description = s } }
func require(_ condition: Bool, _ message: String) throws { if !condition { throw InstallError(message) } }
func put(_ path: String, _ value: [String: Any]) throws {
    let bytes = try JSONSerialization.data(withJSONObject: value)
    try bytes.write(to: URL(fileURLWithPath: path), options: .atomic)
    try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
}
func pump(_ seconds: TimeInterval = 0.1) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }
func digest(_ path: String) throws -> String {
    let file = try FileHandle(forReadingFrom: URL(fileURLWithPath: path)); defer { try? file.close() }
    var hash = SHA256()
    while let part = try file.read(upToCount: 1024 * 1024), !part.isEmpty { hash.update(data: part) }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
}
func real(_ path: String) -> String {
    guard let resolved = Darwin.realpath(path, nil) else { return "" }
    defer { free(resolved) }
    return String(cString: resolved)
}
func run(_ executable: String, _ args: [String]) throws {
    let process = Process(); process.executableURL = URL(fileURLWithPath: executable); process.arguments = args
    process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
    try process.run(); process.waitUntilExit()
    try require(process.terminationStatus == 0, "无法解压更新包")
}
func launch(_ target: String, arguments: [String], dataDirectory: String) throws -> NSRunningApplication {
    var finished = false; var application: NSRunningApplication?; var launchError: Error?
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.arguments = arguments
    configuration.createsNewApplicationInstance = true
    configuration.environment = ["WORKSPACE_DATA_DIR": dataDirectory]
    NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: target), configuration: configuration) { app, error in
        DispatchQueue.main.async { application = app; launchError = error; finished = true }
    }
    let deadline = Date().addingTimeInterval(60)
    while !finished && Date() < deadline { pump() }
    if let error = launchError { throw error }
    guard let app = application else { throw InstallError("macOS 未能启动新版，请检查系统安全提示") }
    return app
}
func swap(_ left: String, _ right: String) throws {
    let result = left.withCString { l in right.withCString { r in renamex_np(l, r, UInt32(RENAME_SWAP | RENAME_NOFOLLOW_ANY)) } }
    try require(result == 0, "无法原子替换 App（\(errno)），请手动安装")
}

var rollback: (() throws -> Void)?
var stageToClean: String?
var job = ""
do {
    try require(CommandLine.arguments.count == 2, "安装请求无效")
    job = real(CommandLine.arguments[1])
    let attrs = try fm.attributesOfItem(atPath: job)
    try require((attrs[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(), "安装任务不属于当前用户")
    let request = try JSONDecoder().decode(Request.self, from: Data(contentsOf: URL(fileURLWithPath: job + "/request.json")))
    let target = real(request.target)
    let homeTarget = real(NSHomeDirectory() + "/Applications/All In One Workspace.app")
    var validTarget = target == homeTarget || target == "/Applications/All In One Workspace.app"
    #if UPDATE_TESTING
    validTarget = validTarget || (target.hasPrefix("/private/tmp/aio-updater-test-") && target.hasSuffix("/All In One Workspace.app"))
    #endif
    try require(validTarget && target == request.target, "不支持此安装位置")
    let parent = URL(fileURLWithPath: target).deletingLastPathComponent().path
    try require(fm.isWritableFile(atPath: parent) && fm.isWritableFile(atPath: target), "应用目录不可写，请手动安装")
    let stage = request.stage
    try require(stage == parent + "/.aio-update-" + request.nonce && !fm.fileExists(atPath: stage), "安装暂存目录无效")
    try require(UUID(uuidString: request.nonce) != nil, "安装会话无效")
    let bytes = try Data(contentsOf: URL(fileURLWithPath: request.manifestPath))
    try require(bytes.count <= 65536, "更新清单过大")
    let signature = try String(contentsOfFile: request.signaturePath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    guard let keyBytes = Data(base64Encoded: trustedUpdateKey), let signatureBytes = Data(base64Encoded: signature) else { throw InstallError("更新签名格式无效") }
    let key = try Curve25519.Signing.PublicKey(rawRepresentation: keyBytes)
    try require(key.isValidSignature(signatureBytes, for: bytes), "更新签名无效")
    let manifest = try JSONDecoder().decode(Manifest.self, from: bytes)
    try require(manifest.schemaVersion == 1 && manifest.repository == "KonjakZhou/AllInOneWorkspace" && manifest.bundleId == "local.allinone.workspace" && manifest.platform == "darwin" && manifest.arch == "arm64", "更新清单不兼容")
    let oldInfo = NSDictionary(contentsOfFile: target + "/Contents/Info.plist")
    try require(oldInfo?["CFBundleIdentifier"] as? String == manifest.bundleId, "当前 App 身份不匹配")
    guard let oldVersion = oldInfo?["CFBundleShortVersionString"] as? String else { throw InstallError("当前版本无效") }
    try require(manifest.version.compare(oldVersion, options: .numeric) == .orderedDescending, "拒绝降级或重复安装")
    let size = (try fm.attributesOfItem(atPath: request.archive)[.size] as? NSNumber)?.intValue
    try require(size == manifest.zip.size && manifest.zip.size <= 1073741824, "安装包大小不符")
    let hash = try digest(request.archive)
    try require(hash == manifest.zip.sha256, "安装包已变化，拒绝安装")
    try fm.createDirectory(atPath: stage, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    stageToClean = stage
    try run("/usr/bin/ditto", ["-x", "-k", request.archive, stage])
    let candidate = stage + "/All In One Workspace.app"
    try require(try fm.contentsOfDirectory(atPath: stage) == ["All In One Workspace.app"], "更新包结构无效")
    guard let enumerator = fm.enumerator(atPath: candidate) else { throw InstallError("无法校验解压内容") }
    for case let entry as String in enumerator {
        try require(real(candidate + "/" + entry).hasPrefix(candidate + "/"), "解压内容包含逃逸的链接")
    }
    let newInfo = NSDictionary(contentsOfFile: candidate + "/Contents/Info.plist")
    try require(newInfo?["CFBundleIdentifier"] as? String == manifest.bundleId && newInfo?["CFBundleShortVersionString"] as? String == manifest.version, "新版 App 与更新清单不匹配")
    try put(job + "/status.json", ["phase": "prepared", "nonce": request.nonce])
    let deadline = Date().addingTimeInterval(90)
    while Date() < deadline {
        if fm.fileExists(atPath: job + "/cancel") { throw InstallError("更新已取消") }
        let authorized = (try? String(contentsOfFile: job + "/go", encoding: .utf8)) == request.nonce
        if authorized && kill(request.parentPid, 0) != 0 && errno == ESRCH { break }
        pump()
    }
    try require(Date() < deadline, "原应用尚未退出，已取消替换")
    try put(job + "/status.json", ["phase": "swapping", "nonce": request.nonce])
    try swap(target, candidate)
    rollback = {
        try swap(target, candidate)
        _ = try launch(target, arguments: [], dataDirectory: request.dataDirectory)
    }
    try put(job + "/status.json", ["phase": "launching", "nonce": request.nonce])
    let launched = try launch(target, arguments: ["--aio-update-job", job, "--aio-update-nonce", request.nonce], dataDirectory: request.dataDirectory)
    let healthDeadline = Date().addingTimeInterval(45)
    while Date() < healthDeadline && !launched.isTerminated {
        if (try? String(contentsOfFile: job + "/health", encoding: .utf8)) == request.nonce { break }
        pump()
    }
    if (try? String(contentsOfFile: job + "/health", encoding: .utf8)) != request.nonce || launched.isTerminated {
        launched.forceTerminate()
        let deadline = Date().addingTimeInterval(10)
        while !launched.isTerminated && Date() < deadline { pump() }
        if !launched.isTerminated { rollback = nil; stageToClean = nil; throw InstallError("新版尚未退出，旧 App 已保留在暂存目录，请手动恢复") }
        throw InstallError("新版未能完成启动检查，已恢复旧版")
    }
    // This is the commit point. The new process waits here before opening any user data.
    try put(job + "/status.json", ["phase": "committed", "nonce": request.nonce])
    rollback = nil
    do { try request.nonce.write(toFile: job + "/continue", atomically: true, encoding: .utf8) }
    catch { stageToClean = nil; throw error }
    try? fm.removeItem(atPath: stage)
    stageToClean = nil
} catch {
    var message = String(describing: error)
    if let restore = rollback {
        do { try? put(job + "/status.json", ["phase": "failed", "message": message]); try restore(); rollback = nil } catch { message += "；恢复未完成，旧 App 已保留：\(error)"; stageToClean = nil }
    }
    if let stage = stageToClean { try? fm.removeItem(atPath: stage) }
    if !job.isEmpty { try? put(job + "/status.json", ["phase": "failed", "message": message]) }
    exit(1)
}
