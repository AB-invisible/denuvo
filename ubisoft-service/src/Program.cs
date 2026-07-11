using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

// ─────────────────────────────────────────────────────────────────────────
// UbiTokenService — tiny HTTP wrapper around DenuvoTicket.dll
//
// The Discord bot (on Railway) can't run the Ubisoft token minter itself:
// the tool is a .NET 8 CONSOLE app that reads config.ini / LoginStore.dat
// from its working directory, writes token/token.ini, and calls
// Environment.Exit(). This service wraps it behind one endpoint:
//
//   POST /ubisoft/token   { "ubisoftAppId": 8006, "ticket": "<token_req>" }
//     → 200 { "token": "...", "ownership": "..." }
//     → 4xx/5xx { "error": "...", "code": "ExceededActivations|NotOwned|..." }
//
// Each request runs the tool in a fresh temp working dir so concurrent
// requests never clobber each other's config.ini / token output. The
// Ubisoft device-trust file (LoginStore.dat) is seeded once via a mounted
// volume (LOGIN_STORE_PATH) and copied in/out per request so 2FA is only
// needed on the very first interactive login.
//
// Auth: every request must carry X-Api-Key matching UBISOFT_SERVICE_KEY.
// ─────────────────────────────────────────────────────────────────────────

var builder = WebApplication.CreateBuilder(args);
builder.Logging.AddSimpleConsole(o => { o.SingleLine = true; o.TimestampFormat = "HH:mm:ss "; });
var app = builder.Build();
var log = app.Logger;

string Env(string key, string fallback = "") =>
    Environment.GetEnvironmentVariable(key)?.Trim() is { Length: > 0 } v ? v : fallback;

// ── Config from environment ──────────────────────────────────────────────
// Directory holding DenuvoTicket.dll + its managed dependencies. Defaults
// to /app/tool (where the Dockerfile copies them).
var toolDir = Env("UBISOFT_TOOL_DIR", "/app/tool");
var toolDll = Path.Combine(toolDir, "DenuvoTicket.dll");

// Default Ubisoft account. The bot can override per-request (account pool
// / quota rotation), but a default keeps single-account setups zero-config.
var defaultEmail = Env("UBISOFT_EMAIL");
var defaultPassword = Env("UBISOFT_PASSWORD");

// Persisted device-trust store. Mount a Railway volume here so the trusted
// device survives redeploys and 2FA is only needed once.
var loginStorePath = Env("LOGIN_STORE_PATH", "/data/LoginStore.dat");

// Shared secret the bot must present. If unset the service refuses to start
// authenticated routes (fail closed rather than run wide open).
var apiKey = Env("UBISOFT_SERVICE_KEY");

// Per-request wall-clock cap for the tool (Steam CM + Uplay demux can be slow).
var toolTimeoutMs = int.TryParse(Env("UBISOFT_TOOL_TIMEOUT_MS"), out var t) ? t : 120_000;

// Serialize tool runs. The tool writes shared side-effect files (Ownership,
// LoginStore.dat) and hammering Ubisoft auth in parallel invites rate-limits,
// so we run one mint at a time. Concurrency here would only fight itself.
var runLock = new SemaphoreSlim(1, 1);

if (!File.Exists(toolDll))
    log.LogWarning("DenuvoTicket.dll not found at {Path} — /ubisoft/token will fail until the tool is present.", toolDll);
if (apiKey.Length == 0)
    log.LogWarning("UBISOFT_SERVICE_KEY is not set — authenticated routes will reject every request. Set it to enable the service.");

app.MapGet("/health", () => Results.Ok(new { ok = true, tool = File.Exists(toolDll) }));

app.MapPost("/ubisoft/token", async (HttpRequest req) =>
{
    // ── Auth ──
    if (apiKey.Length == 0)
        return Results.Json(new ErrorResponse("service not configured (missing UBISOFT_SERVICE_KEY)"), statusCode: 503);
    var presented = req.Headers["X-Api-Key"].ToString();
    if (!FixedTimeEquals(presented, apiKey))
        return Results.Json(new ErrorResponse("unauthorized"), statusCode: 401);

    // ── Parse body ──
    TokenRequest? body;
    try
    {
        body = await JsonSerializer.DeserializeAsync<TokenRequest>(req.Body);
    }
    catch (Exception e)
    {
        return Results.Json(new ErrorResponse($"invalid JSON body: {e.Message}"), statusCode: 400);
    }
    if (body is null || body.UbisoftAppId <= 0 || string.IsNullOrWhiteSpace(body.Ticket))
        return Results.Json(new ErrorResponse("body must include ubisoftAppId (>0) and ticket"), statusCode: 400);

    var email = string.IsNullOrWhiteSpace(body.Email) ? defaultEmail : body.Email!.Trim();
    var password = string.IsNullOrWhiteSpace(body.Password) ? defaultPassword : body.Password!;
    if (email.Length == 0 || password.Length == 0)
        return Results.Json(new ErrorResponse("no Ubisoft account: set UBISOFT_EMAIL/UBISOFT_PASSWORD or pass email/password"), statusCode: 400);

    if (!File.Exists(toolDll))
        return Results.Json(new ErrorResponse($"tool not installed at {toolDll}"), statusCode: 500);

    await runLock.WaitAsync();
    var workDir = Path.Combine(Path.GetTempPath(), "ubitok-" + Guid.NewGuid().ToString("N"));
    try
    {
        Directory.CreateDirectory(workDir);
        Directory.CreateDirectory(Path.Combine(workDir, "token"));

        // config.ini: [Settings] + the account section so both the -login
        // path and the tool's stored-password path resolve this account.
        var cfg = new StringBuilder();
        cfg.Append("DwE\n\n[Settings]\n");
        cfg.Append("auto_copy_token=false\n");
        cfg.Append("auto_login_last_account=false\n");
        cfg.Append($"last_used_account={email}\n");
        cfg.Append("use_stubbed_device=true\n\n");
        cfg.Append($"[{email}]\npassword={password}\n");
        await File.WriteAllTextAsync(Path.Combine(workDir, "config.ini"), cfg.ToString());

        // Seed the trusted-device store so automated logins skip 2FA.
        if (File.Exists(loginStorePath))
        {
            try { File.Copy(loginStorePath, Path.Combine(workDir, "LoginStore.dat"), overwrite: true); }
            catch (Exception e) { log.LogWarning("Could not seed LoginStore.dat: {Msg}", e.Message); }
        }
        else
        {
            log.LogWarning("No LoginStore.dat at {Path} — first login will require interactive 2FA seeding.", loginStorePath);
        }

        var tokenArg = $"{body.Ticket!.Trim()}|{body.UbisoftAppId}";
        var psi = new ProcessStartInfo
        {
            FileName = "dotnet",
            WorkingDirectory = workDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add(toolDll);
        psi.ArgumentList.Add("-login");
        psi.ArgumentList.Add(email);
        psi.ArgumentList.Add("-password");
        psi.ArgumentList.Add(password);
        psi.ArgumentList.Add("-token");
        psi.ArgumentList.Add(tokenArg);
        // The tool disables its own console output during login, but keep a
        // dumb terminal hint so any stray Console.CursorVisible call on a
        // redirected stream is a harmless no-op instead of throwing.
        psi.Environment["TERM"] = "dumb";
        psi.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";

        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        using var proc = new Process { StartInfo = psi };
        proc.OutputDataReceived += (_, e) => { if (e.Data != null) stdout.AppendLine(e.Data); };
        proc.ErrorDataReceived += (_, e) => { if (e.Data != null) stderr.AppendLine(e.Data); };

        var startedAt = Stopwatch.StartNew();
        proc.Start();
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();
        proc.StandardInput.Close();

        if (!await WaitForExitAsync(proc, toolTimeoutMs))
        {
            try { proc.Kill(entireProcessTree: true); } catch { }
            log.LogError("Tool timed out after {Ms}ms for appId {AppId}", toolTimeoutMs, body.UbisoftAppId);
            return Results.Json(new ErrorResponse("tool timed out", "Timeout"), statusCode: 504);
        }

        var combined = stdout.ToString() + "\n" + stderr.ToString();
        log.LogInformation("Tool exited {Code} in {Ms}ms (appId {AppId})", proc.ExitCode, startedAt.ElapsedMilliseconds, body.UbisoftAppId);

        // Persist any refreshed device-trust data back to the shared volume.
        var producedStore = Path.Combine(workDir, "LoginStore.dat");
        if (File.Exists(producedStore))
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(loginStorePath)!);
                File.Copy(producedStore, loginStorePath, overwrite: true);
            }
            catch (Exception e) { log.LogWarning("Could not persist LoginStore.dat: {Msg}", e.Message); }
        }

        var tokenIni = Path.Combine(workDir, "token", "token.ini");
        if (proc.ExitCode == 0 && File.Exists(tokenIni))
        {
            var (token, ownership) = ParseTokenIni(await File.ReadAllTextAsync(tokenIni));
            if (token.Length == 0)
                return Results.Json(new ErrorResponse("tool succeeded but token.ini had no token", "ParseError") { Logs = Tail(combined) }, statusCode: 500);
            return Results.Ok(new TokenResponse(token, ownership));
        }

        // Map the tool's known failure phrases to stable codes for the bot.
        var code = ClassifyFailure(combined);
        var status = code == "ExceededActivations" ? 429 : 502;
        return Results.Json(new ErrorResponse(FailureMessage(code), code) { Logs = Tail(combined) }, statusCode: status);
    }
    catch (Exception e)
    {
        log.LogError(e, "Unhandled error minting Ubisoft token");
        return Results.Json(new ErrorResponse($"internal error: {e.Message}"), statusCode: 500);
    }
    finally
    {
        try { Directory.Delete(workDir, recursive: true); } catch { }
        runLock.Release();
    }
});

app.Run();

// ── Helpers ───────────────────────────────────────────────────────────────
static (string token, string ownership) ParseTokenIni(string ini)
{
    string token = "", ownership = "";
    foreach (var raw in ini.Split('\n'))
    {
        var line = raw.Trim();
        if (line.StartsWith("token=", StringComparison.OrdinalIgnoreCase)) token = line.Substring(6).Trim();
        else if (line.StartsWith("ownership=", StringComparison.OrdinalIgnoreCase)) ownership = line.Substring(10).Trim();
    }
    return (token, ownership);
}

static string ClassifyFailure(string logs)
{
    if (logs.Contains("Daily token limit", StringComparison.OrdinalIgnoreCase) ||
        logs.Contains("ExceededActivations", StringComparison.OrdinalIgnoreCase)) return "ExceededActivations";
    if (logs.Contains("do not own", StringComparison.OrdinalIgnoreCase) ||
        logs.Contains("Unsupported game", StringComparison.OrdinalIgnoreCase) ||
        logs.Contains("NotOwned", StringComparison.OrdinalIgnoreCase)) return "NotOwned";
    if (logs.Contains("malformed ticket", StringComparison.OrdinalIgnoreCase) ||
        logs.Contains("invalid AppID", StringComparison.OrdinalIgnoreCase)) return "InvalidRequest";
    if (logs.Contains("Login failed", StringComparison.OrdinalIgnoreCase) ||
        logs.Contains("Unauthorized", StringComparison.OrdinalIgnoreCase) ||
        logs.Contains("2FA", StringComparison.OrdinalIgnoreCase)) return "LoginFailed";
    return "Failure";
}

static string FailureMessage(string code) => code switch
{
    "ExceededActivations" => "daily activation limit reached for this Ubisoft account",
    "NotOwned" => "the Ubisoft account does not own this game / appId",
    "InvalidRequest" => "malformed token request or invalid appId",
    "LoginFailed" => "Ubisoft login failed (bad credentials, expired device trust, or 2FA required)",
    _ => "token generation failed",
};

// Keep only the last chunk of tool output so error payloads stay small.
static string Tail(string s, int max = 2000) => s.Length <= max ? s.Trim() : s[^max..].Trim();

static async Task<bool> WaitForExitAsync(Process proc, int timeoutMs)
{
    using var cts = new CancellationTokenSource(timeoutMs);
    try { await proc.WaitForExitAsync(cts.Token); return true; }
    catch (OperationCanceledException) { return false; }
}

static bool FixedTimeEquals(string a, string b)
{
    var ba = Encoding.UTF8.GetBytes(a);
    var bb = Encoding.UTF8.GetBytes(b);
    return System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(ba, bb);
}

// ── DTOs ────────────────────────────────────────────────────────────────
record TokenRequest
{
    [JsonPropertyName("ubisoftAppId")] public int UbisoftAppId { get; init; }
    [JsonPropertyName("ticket")] public string? Ticket { get; init; }
    [JsonPropertyName("email")] public string? Email { get; init; }
    [JsonPropertyName("password")] public string? Password { get; init; }
}

record TokenResponse(
    [property: JsonPropertyName("token")] string Token,
    [property: JsonPropertyName("ownership")] string Ownership);

record ErrorResponse(
    [property: JsonPropertyName("error")] string Error,
    [property: JsonPropertyName("code")] string? Code = null)
{
    [JsonPropertyName("logs")] public string? Logs { get; init; }
}
