# Builds app/mdkit.ico from the app mark that actually ships: the inline SVG favicon in
# app/index.html. Nothing is re-typed here on purpose - the day the "#" got smaller, a hand-copied
# second set of coordinates would have silently kept drawing the old, bigger one.
# ASCII only: Windows PowerShell 5.1 reads .ps1 as GBK, so any non-ASCII byte - even in a comment -
# can break parsing.
param(
    [string]$Svg = 'H:\rea\mdkit\app\index.html',
    [string]$Out = 'H:\rea\mdkit\app\mdkit.ico'
)

Add-Type -AssemblyName System.Drawing

$raw = [System.IO.File]::ReadAllText($Svg)
$m = [regex]::Match($raw, 'rel="icon" href="data:image/svg\+xml,([^"]+)"')
if (-not $m.Success) { Write-Error 'no favicon link found - nothing to draw, refusing to emit an empty icon'; exit 1 }
$svg = [System.Uri]::UnescapeDataString($m.Groups[1].Value)

$stroke = [double](
    [regex]::Match($svg, "stroke-width='([\d.]+)'").Groups[1].Value)
$d = [regex]::Match($svg, "d='([^']+)'").Groups[1].Value
$tileHex = [regex]::Match($svg, "rx='[\d.]+' fill='#([0-9a-fA-F]{6})'").Groups[1].Value
$inkHex = [regex]::Match($svg, "stroke='#([0-9a-fA-F]{6})'").Groups[1].Value
$radius = [double](
    [regex]::Match($svg, "rx='([\d.]+)'").Groups[1].Value)

# path data is absolute only (M x y L x y, repeated) - split on M, take four numbers per segment
$lines = @()
foreach ($seg in ($d -split 'M')) {
    if ($seg.Trim() -eq '') { continue }
    $n = @([regex]::Matches($seg, '-?\d+(?:\.\d+)?') | ForEach-Object { [double]$_.Value })
    if ($n.Count -lt 4) { continue }
    $lines += , @($n[0], $n[1], $n[2], $n[3])
}
if ($lines.Count -eq 0 -or $stroke -le 0 -or -not $tileHex -or -not $inkHex) {
    Write-Error ("parsed lines={0} stroke={1} tile={2} ink={3} - refusing to emit a broken icon" -f $lines.Count, $stroke, $tileHex, $inkHex)
    exit 1
}
Write-Output ("mark: {0} segments, stroke {1}, rx {2}, #{3} on #{4}" -f $lines.Count, $stroke, $radius, $inkHex, $tileHex)

function Hex([string]$h) {
    return [System.Drawing.Color]::FromArgb(255,
        [Convert]::ToInt32($h.Substring(0, 2), 16), [Convert]::ToInt32($h.Substring(2, 2), 16), [Convert]::ToInt32($h.Substring(4, 2), 16))
}
$tile = Hex $tileHex
$ink = Hex $inkHex
$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)

function Draw-Frame([int]$s) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $k = $s / 24.0
    $r = $radius * $k
    $dd = $r * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc([single]0, [single]0, [single]$dd, [single]$dd, 180, 90)
    $path.AddArc([single]($s - $dd), [single]0, [single]$dd, [single]$dd, 270, 90)
    $path.AddArc([single]($s - $dd), [single]($s - $dd), [single]$dd, [single]$dd, 0, 90)
    $path.AddArc([single]0, [single]($s - $dd), [single]$dd, [single]$dd, 90, 90)
    $path.CloseFigure()
    $b = New-Object System.Drawing.SolidBrush($tile)
    $g.FillPath($b, $path)
    $b.Dispose()
    $pen = New-Object System.Drawing.Pen($ink, [single]($stroke * $k))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    foreach ($ln in $lines) {
        $g.DrawLine($pen, [single]($ln[0] * $k), [single]($ln[1] * $k), [single]($ln[2] * $k), [single]($ln[3] * $k))
    }
    $pen.Dispose()
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return , $ms.ToArray()
}

$frames = @()
foreach ($s in $sizes) { $frames += , @{ size = $s; png = (Draw-Frame $s) } }

$ms2 = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($ms2)
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$frames.Count)
$off = 6 + (16 * $frames.Count)
foreach ($f in $frames) {
    $s = $f.size
    $wb = if ($s -ge 256) { 0 } else { $s }
    $w.Write([byte]$wb); $w.Write([byte]$wb); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$f.png.Length); $w.Write([uint32]$off)
    $off += $f.png.Length
}
foreach ($f in $frames) { $w.Write($f.png) }
$w.Flush()
[System.IO.File]::WriteAllBytes($Out, $ms2.ToArray())
$w.Dispose()
$fi = Get-Item $Out
Write-Output ("ico {0} frames={1} bytes={2}" -f $fi.Name, $frames.Count, $fi.Length)
