$port = 3000
$file = 'C:\Users\zoeal\zoe-app\index.html'
$repo = 'C:\Users\zoeal\zoe-app'
$l = [Net.HttpListener]::new()
$l.Prefixes.Add("http://localhost:$port/")
$l.Start()
Write-Host "Serving at http://localhost:$port (reloads on commit only)"
while ($l.IsListening) {
    $c = $l.GetContext()
    if ($c.Request.Url.LocalPath -eq '/reload-check') {
        $hash = & git -C $repo rev-parse HEAD 2>$null
        $b = [Text.Encoding]::UTF8.GetBytes($hash)
        $c.Response.ContentType = 'text/plain'
        $c.Response.ContentLength64 = $b.Length
        $c.Response.OutputStream.Write($b, 0, $b.Length)
    } else {
        $html = [IO.File]::ReadAllText($file)
        $script = '<script>!function(){var t=null;setInterval(function(){fetch("/reload-check").then(r=>r.text()).then(m=>{if(t&&m!==t)location.reload();t=m})},1500)}()</script>'
        $html = $html.Replace('</body>', $script + '</body>')
        $b = [Text.Encoding]::UTF8.GetBytes($html)
        $c.Response.ContentType = 'text/html; charset=utf-8'
        $c.Response.ContentLength64 = $b.Length
        $c.Response.OutputStream.Write($b, 0, $b.Length)
    }
    $c.Response.Close()
}
