# Dictation for the Ask Claude box.
#
# Two engines live in Windows and they are not close in quality.
#
#   The modern one is what Win+H uses. It is a dictation engine, it knows this
#   country's English, and it is the reason dictation on a phone works. It needs
#   the speech privacy policy accepted once in Windows Settings, and Windows may
#   use its online service to do the recognising when it is.
#
#   The desktop one, System.Speech, is the Windows 7 command-and-control engine.
#   It needs nothing switched on and nothing leaves the machine. It is also, for
#   free dictation, poor: it has no en-AU at all, so an Australian voice is being
#   read against a British command grammar.
#
# So: use the modern one where it will run, fall back to the desktop one where it
# will not, and say which is which rather than leaving anyone guessing why it is
# suddenly better or worse.
#
# Writes one JSON object per line to standard output and keeps listening until it
# is stopped. Nothing is recorded and nothing is written to disk.
#
# ASCII only. PowerShell 5.1 reads a BOM-less UTF-8 file as ANSI, and a stray
# em dash in a string is a parse error rather than a typo.

$ErrorActionPreference = 'Stop'

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

$wantEngine = $env:BATHROOM_DICTATE_ENGINE
if (-not $wantEngine) { $wantEngine = 'auto' }
$wantLang = $env:BATHROOM_DICTATE_LANG

$parent = 0
if ($env:BATHROOM_DICTATE_PARENT) { [int]::TryParse($env:BATHROOM_DICTATE_PARENT, [ref]$parent) | Out-Null }
function ParentGone { if ($parent -le 0) { return $false } ; return -not (Get-Process -Id $parent -ErrorAction SilentlyContinue) }

# ---------------------------------------------------------------------------
# The modern engine, driven by reflection.
#
# Every WinRT object arrives here as a runtime-callable wrapper whose own type
# declares none of its members, so everything goes through the type out of the
# metadata and never through obj.GetType(). Three things bite in a row: the
# constraint collection's Add is on ICollection<T> rather than IList<T>, an
# async operation's Status is on IAsyncInfo rather than on the operation, and
# .NET flatly refuses EventInfo.AddEventHandler on a WinRT event so the add
# accessor has to be called directly.
# ---------------------------------------------------------------------------
$modernSrc = @'
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Reflection;
using System.Globalization;

public static class WinRtSpeech {
  public static ConcurrentQueue<string> Q = new ConcurrentQueue<string>();
  static object rec, session;
  static Type SR, SESS;
  public static volatile bool Stopping = false;

  static Type T(string n){ return Type.GetType(n + ", Windows, ContentType=WindowsRuntime"); }
  static object Get(Type t, string p, object o){ return t.GetProperty(p).GetValue(o, null); }
  static object Call(Type t, string m, object o, params object[] a){
    var mi = t.GetMethod(m, a.Length == 0 ? Type.EmptyTypes : Array.ConvertAll(a, x => x.GetType()));
    if(mi == null) mi = t.GetMethod(m);
    return mi.Invoke(o, a);
  }
  static void AwaitDone(object op){
    var st = T("Windows.Foundation.IAsyncInfo").GetProperty("Status");
    while(Convert.ToInt32(st.GetValue(op, null)) == 0) System.Threading.Thread.Sleep(20);
  }
  static object AwaitOp(object op, string resultType){
    AwaitDone(op);
    var iface = T("Windows.Foundation.IAsyncOperation`1").MakeGenericType(T(resultType));
    return iface.GetMethod("GetResults").Invoke(op, null);
  }
  static void AwaitAct(object op){
    AwaitDone(op);
    T("Windows.Foundation.IAsyncAction").GetMethod("GetResults").Invoke(op, null);
  }
  static string Esc(string s){
    if(s == null) return "";
    return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
  }
  public static void OnResult(object s, object e){
    try {
      var r  = Get(T("Windows.Media.SpeechRecognition.SpeechContinuousRecognitionResultGeneratedEventArgs"), "Result", e);
      var rt = T("Windows.Media.SpeechRecognition.SpeechRecognitionResult");
      var txt = (string)Get(rt, "Text", r);
      var grade = Get(rt, "Confidence", r).ToString();
      var raw = Convert.ToDouble(Get(rt, "RawConfidence", r));
      if(string.IsNullOrWhiteSpace(txt)) return;
      // Rejected is the engine saying it heard sound and made nothing of it,
      // which is what the room is doing rather than what anyone said.
      if(grade == "Rejected"){ Q.Enqueue("{\"noise\":true,\"confidence\":" + raw.ToString("0.00", CultureInfo.InvariantCulture) + "}"); return; }
      Q.Enqueue("{\"text\":\"" + Esc(txt) + "\",\"grade\":\"" + grade + "\",\"confidence\":"
                + raw.ToString("0.00", CultureInfo.InvariantCulture) + "}");
    } catch(Exception ex){ Q.Enqueue("{\"warn\":\"" + Esc(ex.Message) + "\"}"); }
  }
  public static void OnHypothesis(object s, object e){
    try {
      var h  = Get(T("Windows.Media.SpeechRecognition.SpeechRecognitionHypothesisGeneratedEventArgs"), "Hypothesis", e);
      var txt = (string)Get(T("Windows.Media.SpeechRecognition.SpeechRecognitionHypothesis"), "Text", h);
      if(!string.IsNullOrWhiteSpace(txt)) Q.Enqueue("{\"partial\":\"" + Esc(txt) + "\"}");
    } catch {}
  }
  public static void OnCompleted(object s, object e){
    try {
      var st = Get(T("Windows.Media.SpeechRecognition.SpeechContinuousRecognitionCompletedEventArgs"), "Status", e).ToString();
      Q.Enqueue("{\"ended\":\"" + Esc(st) + "\"}");
    } catch { Q.Enqueue("{\"ended\":\"Unknown\"}"); }
  }
  public static void OnState(object s, object e){
    try {
      var st = Get(T("Windows.Media.SpeechRecognition.SpeechRecognizerStateChangedEventArgs"), "State", e).ToString();
      Q.Enqueue("{\"audio\":\"" + Esc(st) + "\"}");
    } catch {}
  }
  static void Hook(Type declaring, object src, string ev, string method){
    var ei = declaring.GetEvent(ev);
    if(ei == null) throw new Exception("no event " + ev);
    var add = declaring.GetMethod("add_" + ev);
    if(add == null) throw new Exception("no add_" + ev);
    var mi = typeof(WinRtSpeech).GetMethod(method, BindingFlags.Public | BindingFlags.Static);
    add.Invoke(src, new object[]{ Delegate.CreateDelegate(ei.EventHandlerType, mi) });
  }
  // The dictation languages the modern engine actually has.
  public static string[] Languages(){
    try {
      var srT = T("Windows.Media.SpeechRecognition.SpeechRecognizer");
      if(srT == null) return new string[0];
      var langs = srT.GetProperty("SupportedTopicLanguages").GetValue(null, null);
      var lt = T("Windows.Globalization.Language");
      var outv = new List<string>();
      foreach(var l in (System.Collections.IEnumerable)langs) outv.Add((string)Get(lt, "LanguageTag", l));
      return outv.ToArray();
    } catch { return new string[0]; }
  }
  public static string Start(string tag){
    try {
      SR = T("Windows.Media.SpeechRecognition.SpeechRecognizer");
      if(SR == null) return "unavailable:this Windows has no modern speech engine.";
      object lang = Activator.CreateInstance(T("Windows.Globalization.Language"), tag);
      rec = Activator.CreateInstance(SR, lang);
      var scen = T("Windows.Media.SpeechRecognition.SpeechRecognitionScenario");
      var conT = T("Windows.Media.SpeechRecognition.SpeechRecognitionTopicConstraint");
      var con  = Activator.CreateInstance(conT, Enum.Parse(scen, "Dictation"), "d");
      var cons = Get(SR, "Constraints", rec);
      var ciT  = T("Windows.Media.SpeechRecognition.ISpeechRecognitionConstraint");
      typeof(ICollection<>).MakeGenericType(ciT).GetMethod("Add").Invoke(cons, new object[]{ con });
      var res = AwaitOp(Call(SR, "CompileConstraintsAsync", rec),
                        "Windows.Media.SpeechRecognition.SpeechRecognitionCompilationResult");
      var status = Get(T("Windows.Media.SpeechRecognition.SpeechRecognitionCompilationResult"), "Status", res).ToString();
      if(status != "Success") return "unavailable:the modern engine would not start (" + status + ").";
      SESS = T("Windows.Media.SpeechRecognition.SpeechContinuousRecognitionSession");
      session = Get(SR, "ContinuousRecognitionSession", rec);
      Hook(SESS, session, "ResultGenerated", "OnResult");
      Hook(SESS, session, "Completed", "OnCompleted");
      Hook(SR, rec, "HypothesisGenerated", "OnHypothesis");
      Hook(SR, rec, "StateChanged", "OnState");
      AwaitAct(Call(SESS, "StartAsync", session));
      return "ok:" + (string)Get(T("Windows.Globalization.Language"), "LanguageTag", Get(SR, "CurrentLanguage", rec));
    } catch(Exception ex){
      var m = ex.InnerException != null ? ex.InnerException.Message : ex.Message;
      if(m != null && m.IndexOf("privacy", StringComparison.OrdinalIgnoreCase) >= 0) return "privacy:" + m.Trim();
      return "unavailable:" + (m == null ? ex.GetType().Name : m.Trim());
    }
  }
  // The continuous session can finish on its own - a long silence, or the
  // engine deciding it has had enough. Left alone the script would go on
  // looking like it was listening while nothing was being heard at all, which
  // is the worst of the states it could be in. So it goes again.
  public static bool Restart(){
    try { AwaitAct(Call(SESS, "StartAsync", session)); return true; } catch { return false; }
  }
  public static void Stop(){
    Stopping = true;
    try { if(session != null) AwaitAct(Call(SESS, "StopAsync", session)); } catch {}
    try { if(rec != null) Call(SR, "Dispose", rec); } catch {}
    rec = null; session = null;
  }
}
'@

function Start-Modern {
  if ($wantEngine -eq 'desktop') { return $null }
  try { Add-Type -TypeDefinition $modernSrc -Language CSharp -ErrorAction Stop } catch { return @{ why = 'unavailable'; message = 'This Windows cannot run the modern speech engine.' } }

  $have = [WinRtSpeech]::Languages()
  if (-not $have -or $have.Count -eq 0) { return @{ why = 'unavailable'; message = 'The modern speech engine has no dictation language installed.' } }
  # The country's own English first: it is the whole reason for using this engine.
  $order = @()
  if ($wantLang) { $order += $wantLang }
  $order += @('en-AU', 'en-GB', 'en-US')
  $tag = $null
  foreach ($o in $order) { if ($have -contains $o) { $tag = $o; break } }
  if (-not $tag) { $tag = $have[0] }

  $r = [WinRtSpeech]::Start($tag)
  if ($r -like 'ok:*') { return @{ ok = $true; lang = $r.Substring(3); available = $have } }
  if ($r -like 'privacy:*') {
    return @{ why = 'privacy'; lang = $tag; available = $have; message =
      'Dictation is on the older Windows engine, which has no Australian English - only British and American. The modern engine has en-AU and is much the better recogniser, but Windows will not start it until its speech privacy policy is accepted. Windows may then use its online service to do the recognising; until it is on, nothing leaves this machine.' }
  }
  return @{ why = 'unavailable'; message = ($r -replace '^unavailable:', '') }
}

$modern = Start-Modern
if ($modern -and $modern.ok) {
  Emit @{ ready = $true; engine = 'modern'; culture = $modern.lang; available = @($modern.available) }
  $lastAt = [DateTime]::UtcNow
  $warned = $false
  try {
    while ($true) {
      if (ParentGone) { break }
      $line = $null
      if ([WinRtSpeech]::Q.TryDequeue([ref]$line)) {
        # A session that ended by itself is started again, quietly. Anyone
        # dictating did not ask for it to stop and should not have to notice.
        if ($line -like '*"ended"*' -and -not [WinRtSpeech]::Stopping) {
          if ([WinRtSpeech]::Restart()) { continue }
          Emit @{ error = 'Dictation stopped and would not start again.' }
          break
        }
        [Console]::Out.WriteLine($line); [Console]::Out.Flush()
        $lastAt = [DateTime]::UtcNow
        $warned = $true          # something is coming through; no need to warn
        continue
      }
      Start-Sleep -Milliseconds 60
      if (-not $warned -and ([DateTime]::UtcNow - $lastAt).TotalSeconds -gt 8) {
        $warned = $true
        Emit @{ silent = $true; message = 'Not hearing anything from the microphone. Check it is not muted, that it is the default input device, and that desktop apps are allowed to use it.' }
      }
    }
  } finally { [WinRtSpeech]::Stop() }
  exit 0
}

# The modern engine is not going to run. Say why once, then carry on with the
# one that will - a worse recogniser is better than no dictation.
if ($modern) {
  Emit @{ engineNote = $true; why = $modern.why; message = $modern.message }
}


try {
  Add-Type -AssemblyName System.Speech
} catch {
  Emit @{ error = 'Windows speech is not available on this machine.' }
  exit 1
}

$installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
if (-not $installed -or $installed.Count -eq 0) {
  Emit @{ error = 'No speech recogniser is installed. Add one under Windows Settings, Time and language, Speech.' }
  exit 1
}

# en-AU is rarely installed; en-GB is the closer of the two that usually are.
$want = $wantLang
if (-not $want) { $want = 'en-GB' }
$pick = $installed | Where-Object { $_.Culture.Name -eq $want } | Select-Object -First 1
if (-not $pick) { $pick = $installed | Where-Object { $_.Culture.Name -like 'en-*' } | Select-Object -First 1 }
if (-not $pick) { $pick = $installed[0] }

$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine $pick
try {
  $rec.SetInputToDefaultAudioDevice()
} catch {
  Emit @{ error = 'No microphone. Check the input device in Windows sound settings, and that desktop apps are allowed to use it under Privacy and security, Microphone.' }
  exit 1
}
$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))

# Both of these end a recognition when they expire, and in continuous mode that
# ends the run. Zero disables them: silence is just silence, and noise it cannot
# parse is just noise. Stopping is the caller's decision, not the timer's.
$rec.InitialSilenceTimeout = [TimeSpan]::Zero
$rec.BabbleTimeout         = [TimeSpan]::Zero
# How long a pause ends a sentence. Long enough to think mid-sentence, short
# enough that the words arrive while they are still worth having.
$rec.EndSilenceTimeout          = [TimeSpan]::FromSeconds(0.9)
$rec.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromSeconds(1.2)

# Queued rather than handled inline: an -Action block runs in its own runspace,
# where writing to stdout goes somewhere nobody is reading. This way the events
# land in the session queue and the main thread - the one holding stdout - is
# what answers them.
Register-ObjectEvent $rec SpeechRecognized   -SourceIdentifier SR | Out-Null
Register-ObjectEvent $rec SpeechHypothesized -SourceIdentifier SH | Out-Null
Register-ObjectEvent $rec AudioLevelUpdated  -SourceIdentifier AL | Out-Null
Register-ObjectEvent $rec AudioStateChanged  -SourceIdentifier AS | Out-Null

$rec.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)

Emit @{ ready = $true; engine = 'desktop'; culture = $pick.Culture.Name;
        available = @($installed | ForEach-Object { $_.Culture.Name }) }

# Whoever started this should be the one that ends it. If the app goes away
# without getting the chance, the microphone should not stay open.

# A room with a fan in it produces sentences. The desktop recogniser will hand
# back "why are you all" for a passing car and score it 0.03, and putting that in
# the box is worse than putting nothing there. Anything under the floor is
# reported as noise instead of as words, so the panel can say it is hearing
# something but not making sense of it.
$floor = 0.2
if ($env:BATHROOM_DICTATE_FLOOR) {
  $parsed = 0.0
  if ([double]::TryParse($env:BATHROOM_DICTATE_FLOOR, [ref]$parsed)) { $floor = $parsed }
}

$lastLevel = -1
$lastLevelAt = [DateTime]::MinValue
$heardAnything = $false
$startedAt = [DateTime]::UtcNow
$warnedSilent = $false

try {
  while ($true) {
    if ($parent -gt 0) {
      if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { break }
    }

    $e = Wait-Event -Timeout 1
    if ($null -eq $e) {
      # Nothing at all for a while, and no sound has ever arrived: the input
      # device is there but nothing is coming down it. Say so once, rather than
      # sitting there looking like it is listening.
      if (-not $heardAnything -and -not $warnedSilent -and
          ([DateTime]::UtcNow - $startedAt).TotalSeconds -gt 6) {
        $warnedSilent = $true
        Emit @{ silent = $true; message = 'Not hearing anything from the microphone. Check it is not muted, that it is the default input device, and that desktop apps are allowed to use it.' }
      }
      continue
    }

    switch ($e.SourceIdentifier) {
      'AL' {
        $lvl = $e.SourceEventArgs.AudioLevel
        if ($lvl -gt 2) { $heardAnything = $true }
        # These arrive many times a second. Send a coarse one occasionally so
        # the panel can show something moving without being flooded.
        $now = [DateTime]::UtcNow
        $bucket = [math]::Floor($lvl / 10)
        if ($bucket -ne $lastLevel -and ($now - $lastLevelAt).TotalMilliseconds -gt 250) {
          $lastLevel = $bucket
          $lastLevelAt = $now
          Emit @{ level = [int]$lvl }
        }
      }
      'AS' {
        $st = [string]$e.SourceEventArgs.AudioState
        if ($st -eq 'Speech') { $heardAnything = $true }
        Emit @{ audio = $st }
      }
      'SH' {
        $t = $e.SourceEventArgs.Result.Text
        $heardAnything = $true
        if ($t) { Emit @{ partial = $t } }
      }
      'SR' {
        $r = $e.SourceEventArgs.Result
        $heardAnything = $true
        if ($r -and $r.Text) {
          $conf = [math]::Round($r.Confidence, 2)
          if ($conf -lt $floor) { Emit @{ noise = $true; confidence = $conf } }
          else { Emit @{ text = $r.Text; confidence = $conf } }
        }
      }
    }
    Remove-Event -EventIdentifier $e.EventIdentifier -ErrorAction SilentlyContinue
  }
} finally {
  try { $rec.RecognizeAsyncCancel() } catch {}
  Unregister-Event -SourceIdentifier SR -ErrorAction SilentlyContinue
  Unregister-Event -SourceIdentifier SH -ErrorAction SilentlyContinue
  Unregister-Event -SourceIdentifier AL -ErrorAction SilentlyContinue
  Unregister-Event -SourceIdentifier AS -ErrorAction SilentlyContinue
  try { $rec.Dispose() } catch {}
}
