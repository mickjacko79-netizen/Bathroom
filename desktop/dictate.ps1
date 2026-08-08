# Dictation for the Ask Claude box.
#
# Chromium's speech recognition is in Electron but does not work in it — the
# build ships without the backend it calls, so starting it fails immediately with
# a network error, every time, whatever you do. What is left that needs no key,
# no account and no internet is the speech engine already in Windows.
#
# Writes one JSON object per line to standard output and keeps listening until it
# is stopped. Nothing is recorded, nothing is written to disk, and no audio
# leaves the machine — the recogniser is running here.
#
# The first version of this stopped on its own and said nothing while it ran,
# which read as "not working" whether it was or not:
#
#   • Recognize() is one utterance. It returned on the first pause, and its
#     null-on-timeout was treated as "they have finished", so the loop ended.
#   • BabbleTimeout ended it after four seconds of any sound it could not parse.
#     A fan, a radio, a room with people in it — dictation was over before the
#     first word.
#   • Nothing was emitted between starting and a finished sentence, so there was
#     no way to tell listening from broken.
#
# So: recognise continuously, never time out on silence or noise, and say what is
# being heard as it is heard — the level, the half-formed guess, and then the
# sentence. It stops when it is told to, or when whoever started it goes away.

$ErrorActionPreference = 'Stop'

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
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
$want = $env:BATHROOM_DICTATE_LANG
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
# land in the session queue and the main thread — the one holding stdout — is
# what answers them.
Register-ObjectEvent $rec SpeechRecognized   -SourceIdentifier SR | Out-Null
Register-ObjectEvent $rec SpeechHypothesized -SourceIdentifier SH | Out-Null
Register-ObjectEvent $rec AudioLevelUpdated  -SourceIdentifier AL | Out-Null
Register-ObjectEvent $rec AudioStateChanged  -SourceIdentifier AS | Out-Null

$rec.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)

Emit @{ ready = $true; culture = $pick.Culture.Name;
        available = @($installed | ForEach-Object { $_.Culture.Name }) }

# Whoever started this should be the one that ends it. If the app goes away
# without getting the chance, the microphone should not stay open.
$parent = 0
if ($env:BATHROOM_DICTATE_PARENT) { [int]::TryParse($env:BATHROOM_DICTATE_PARENT, [ref]$parent) | Out-Null }

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
