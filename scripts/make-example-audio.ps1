$ErrorActionPreference = 'Stop'
$exampleRoot = Join-Path (Split-Path -Parent $PSScriptRoot) '.cache\example-media'
New-Item -ItemType Directory -Force -Path $exampleRoot | Out-Null
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $speaker.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'en-US' } | Select-Object -First 1
if ($voice) { $speaker.SelectVoice($voice.VoiceInfo.Name) }
$speaker.Rate = -1
$clips = @(
  @{ Name = 'interview.wav'; Text = 'Think about a place where you enjoy studying. What makes this place work well for you? Give a specific example.' },
  @{ Name = 'repeat.wav'; Text = 'The library will stay open until nine this evening.' },
  @{ Name = 'announcement.wav'; Text = 'Attention, students. The campus garden workshop has moved from Saturday to Sunday because of rain. It will still start at ten in the morning. Please bring a water bottle. All gardening tools will be provided.' }
)
try {
  foreach ($clip in $clips) {
    $speaker.SetOutputToWaveFile((Join-Path $exampleRoot $clip.Name))
    $speaker.Speak($clip.Text)
    $speaker.SetOutputToNull()
  }
} finally { $speaker.Dispose() }
Write-Output 'Three original synthetic speech fixtures generated locally.'
