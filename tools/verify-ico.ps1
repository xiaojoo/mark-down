# Reads app/mdkit.ico back, checks the container, and re-runs the 16px legibility metric
# on the frame stored inside it. ASCII only.
param([string]$Ico = 'H:\rea\mdkit\app\mdkit.ico')
Add-Type -AssemblyName System.Drawing
$bytes = [System.IO.File]::ReadAllBytes($Ico)
$br = New-Object System.IO.BinaryReader([System.IO.MemoryStream]::new($bytes))
$null = $br.ReadUInt16(); $type = $br.ReadUInt16(); $n = $br.ReadUInt16()
Write-Output ("type={0} frames={1}" -f $type, $n)
$entries = @()
for ($i = 0; $i -lt $n; $i++) {
    $w = $br.ReadByte(); $h = $br.ReadByte()
    $null = $br.ReadByte(); $null = $br.ReadByte()
    $null = $br.ReadUInt16(); $null = $br.ReadUInt16()
    $sz = $br.ReadUInt32(); $off = $br.ReadUInt32()
    $pw = if ($w -eq 0) { 256 } else { $w }
    $ph = if ($h -eq 0) { 256 } else { $h }
    $entries += , @{ w = $pw; h = $ph; size = $sz; off = $off }
}
Write-Output ("sizes=" + (($entries | ForEach-Object { "$($_.w)" }) -join ','))
# pull the 16px frame out and measure it like the candidate sheet was measured
$e = $entries | Where-Object { $_.w -eq 16 } | Select-Object -First 1
$png = New-Object byte[] $e.size
[Array]::Copy($bytes, $e.off, $png, 0, $e.size)
$bmp = [System.Drawing.Bitmap]::new([System.IO.MemoryStream]::new($png))
Write-Output ("frame16={0}x{1}" -f $bmp.Width, $bmp.Height)
$tile = $bmp.GetPixel(8, 1)
function Ink($x, $y) { $c = $bmp.GetPixel($x, $y)
    return [Math]::Abs($c.R - $tile.R) + [Math]::Abs($c.G - $tile.G) + [Math]::Abs($c.B - $tile.B) -gt 110 }
$inkN = 0
for ($y = 0; $y -lt 16; $y++) { for ($x = 0; $x -lt 16; $x++) { if (Ink $x $y) { $inkN++ } } }
function Midline($dir) { $gaps = @(); $on = $false; $off = 0; $seen = 0
    for ($i = 0; $i -lt 16; $i++) {
        $v = if ($dir -eq 'h') { Ink $i 8 } else { Ink 8 $i }
        if ($v) { if ($seen -gt 0) { $gaps += $off }; $off = 0; $seen++; $on = $true } elseif ($on) { $off++ }
    }
    $mg = if ($gaps.Count) { ($gaps | Measure-Object -Minimum).Minimum } else { 'none' }
    return "$seen strokes / gap $mg" }
Write-Output ("ico@16 ink=" + [Math]::Round($inkN / 256 * 100) + "%  h: " + (Midline 'h') + "  v: " + (Midline 'v'))
$bmp.Dispose(); $br.Close()
