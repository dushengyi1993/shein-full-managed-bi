[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Z0-9]+$')]
    [string]$StoreKey,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 65535)]
    [int]$Port,

    [string]$AssetDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\store-icons')
)

$ErrorActionPreference = 'Stop'
$store = $StoreKey.ToUpperInvariant()
$sessionName = "shein-full-$($store.ToLowerInvariant())"

function Invoke-AgentBrowser {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $raw = & agent-browser --session $sessionName --cdp "http://127.0.0.1:$Port" @Arguments --json 2>&1 | Out-String
    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw "agent-browser returned no output: $($Arguments -join ' ')"
    }

    $response = $raw | ConvertFrom-Json
    if (-not $response.success) {
        throw "agent-browser failed [$($Arguments -join ' ')]: $($response.error)"
    }
    return $response.data
}

function Invoke-BrowserExpression {
    param([Parameter(Mandatory = $true)][string]$Expression)
    return (Invoke-AgentBrowser -Arguments @('eval', $Expression)).result
}

function Select-VisibleDropdownOption {
    param([Parameter(Mandatory = $true)][string]$Title)

    $escapedTitle = $Title.Replace('\', '\\').Replace("'", "\'")
    $marked = Invoke-BrowserExpression -Expression "(()=>{const attr='data-openapi-option-target';document.querySelectorAll('['+attr+']').forEach(item=>item.removeAttribute(attr));const option=Array.from(document.querySelectorAll('.ant-select-item-option')).find(item=>{const rect=item.getBoundingClientRect();const style=getComputedStyle(item);return item.getAttribute('title')==='$escapedTitle'&&rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&item.offsetParent!==null});if(!option)return false;option.setAttribute(attr,'true');return true})()"
    if (-not $marked) {
        throw "Could not locate the visible dropdown option '$Title' for $store."
    }

    Invoke-AgentBrowser -Arguments @('click', "[data-openapi-option-target='true']") | Out-Null
}

function Get-CurrentUrl {
    return [string](Invoke-AgentBrowser -Arguments @('get', 'url')).url
}

function Wait-ForUrlContains {
    param(
        [Parameter(Mandatory = $true)][string]$Needle,
        [int]$TimeoutSeconds = 30
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $url = Get-CurrentUrl
        if ($url.Contains($Needle, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $url
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    throw "Timed out waiting for URL containing '$Needle'; current URL: $url"
}

$expectedListPath = '/backstage/mange-applictions'
$currentUrl = Get-CurrentUrl

if ($currentUrl.Contains('/login', [System.StringComparison]::OrdinalIgnoreCase)) {
    $loginMode = Invoke-BrowserExpression -Expression "JSON.stringify({passwordVisible:!!document.querySelector('input[placeholder=请输入登录密码]'),passwordToggle:Array.from(document.querySelectorAll('*')).some(e=>e.children.length===0&&e.textContent.trim()==='使用密码登录')})"
    $loginModeState = $loginMode | ConvertFrom-Json
    if (-not $loginModeState.passwordVisible) {
        Invoke-AgentBrowser -Arguments @('find', 'text', '使用密码登录', 'click', '--exact') | Out-Null
    }

    $autofillDeadline = (Get-Date).AddSeconds(8)
    do {
        $credentialState = Invoke-BrowserExpression -Expression "JSON.stringify({phoneLen:(document.querySelector('input[placeholder=手机号]')?.value||'').length,passwordLen:(document.querySelector('input[placeholder=请输入登录密码]')?.value||'').length})"
        $credentialLengths = $credentialState | ConvertFrom-Json
        if ($credentialLengths.phoneLen -gt 0 -and $credentialLengths.passwordLen -gt 0) {
            break
        }
        Start-Sleep -Milliseconds 400
    } while ((Get-Date) -lt $autofillDeadline)

    if ($credentialLengths.phoneLen -lt 1 -or $credentialLengths.passwordLen -lt 1) {
        throw "Stored login fields are unavailable for $store; manual login is required in the visible browser."
    }

    Invoke-AgentBrowser -Arguments @('find', 'role', 'button', 'click', '--name', '登 录') | Out-Null
    Wait-ForUrlContains -Needle $expectedListPath -TimeoutSeconds 45 | Out-Null
}

if (-not (Get-CurrentUrl).Contains($expectedListPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unexpected page for ${store}: $(Get-CurrentUrl)"
}

Invoke-AgentBrowser -Arguments @(
    'wait',
    '--fn',
    "!!document.querySelector('span.mr-1.text-sm') && document.querySelectorAll('h3').length > 0 && Array.from(document.images).some(img=>(img.currentSrc||img.src).includes('ssmp-openapiaws'))"
) | Out-Null

$pageStateRaw = Invoke-BrowserExpression -Expression "JSON.stringify({subject:document.querySelector('span.mr-1.text-sm')?.innerText?.trim()||'',apps:Array.from(document.querySelectorAll('h3')).map(h=>({name:h.innerText.trim(),card:h.closest('[class*=card]')?.innerText||h.parentElement?.parentElement?.innerText||''})),iconUrl:(()=>{const img=Array.from(document.images).find(item=>(item.currentSrc||item.src).includes('ssmp-openapiaws'));return img?.currentSrc||img?.src||''})()})"
$pageState = $pageStateRaw | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($pageState.subject)) {
    throw "Could not read the certified developer subject for $store."
}

$semiApp = @($pageState.apps | Where-Object {
    $_.name.StartsWith("$store-", [System.StringComparison]::OrdinalIgnoreCase) -and
    $_.name.Contains('SHEIN运营中台', [System.StringComparison]::Ordinal)
}) | Select-Object -First 1

if (-not $semiApp) {
    throw "Could not locate the existing semi-managed app for $store."
}

$shortName = $semiApp.name.Substring($store.Length + 1)
$shortName = $shortName.Substring(0, $shortName.IndexOf('SHEIN运营中台', [System.StringComparison]::Ordinal))
if ([string]::IsNullOrWhiteSpace($shortName)) {
    throw "Could not derive the Chinese short name from '$($semiApp.name)'."
}

$targetName = "$store-$($shortName)SHEIN全托运营中台"
$existing = @($pageState.apps | Where-Object { $_.name -eq $targetName }) | Select-Object -First 1
if ($existing) {
    [pscustomobject]@{
        StoreKey = $store
        Port = $Port
        State = 'existing'
        Subject = $pageState.subject
        SemiManagedApp = $semiApp.name
        TargetApp = $targetName
        ExistingCard = $existing.card
    } | ConvertTo-Json -Depth 5
    exit 0
}

if ([string]::IsNullOrWhiteSpace($pageState.iconUrl)) {
    throw "Could not locate the existing semi-managed app icon for $store."
}

$iconUri = [Uri]$pageState.iconUrl
if ($iconUri.Scheme -ne 'https' -or $iconUri.Host -ne 'ssmp-openapiaws.s3.us-west-2.amazonaws.com') {
    throw "Unexpected app icon host for $store."
}

New-Item -ItemType Directory -Force -Path $AssetDirectory | Out-Null
$iconPath = Join-Path $AssetDirectory "$($store.ToLowerInvariant())-openapi-app-icon.png"
Invoke-WebRequest -Uri $iconUri.AbsoluteUri -OutFile $iconPath

$iconInfo = Get-Item -LiteralPath $iconPath
if ($iconInfo.Length -le 0 -or $iconInfo.Length -ge 10MB) {
    throw "Downloaded icon has an invalid size for ${store}: $($iconInfo.Length) bytes."
}

Invoke-AgentBrowser -Arguments @('find', 'role', 'button', 'click', '--name', '创建应用') | Out-Null
Wait-ForUrlContains -Needle "$expectedListPath/check" -TimeoutSeconds 30 | Out-Null

Invoke-AgentBrowser -Arguments @('fill', '#appName', $targetName) | Out-Null
Invoke-AgentBrowser -Arguments @('click', '.ant-form-item:has(#mode) .ant-select-selector') | Out-Null
Invoke-AgentBrowser -Arguments @(
    'wait',
    '--fn',
    "Array.from(document.querySelectorAll('.ant-select-item-option')).some(item=>{const rect=item.getBoundingClientRect();return item.getAttribute('title')==='全托管'&&rect.width>0&&rect.height>0&&item.offsetParent!==null})"
) | Out-Null
Select-VisibleDropdownOption -Title '全托管'
Invoke-AgentBrowser -Arguments @('wait', '1200') | Out-Null
Invoke-AgentBrowser -Arguments @(
    'wait',
    '--fn',
    "(document.querySelector('#mode')?.closest('.ant-select')?.innerText||'').includes('全托管') && !(document.querySelector('#mode')?.closest('.ant-select')?.innerText||'').includes('半托管')"
) | Out-Null
Invoke-AgentBrowser -Arguments @('wait', '--text', '当前内容存在以下风险') | Out-Null
Invoke-AgentBrowser -Arguments @(
    'wait',
    '--fn',
    "(document.querySelector('#businessFunction')?.closest('.ant-select')?.innerText||'').includes('先选合作模式')"
) | Out-Null

Invoke-AgentBrowser -Arguments @('click', '.ant-form-item:has(#businessFunction) .ant-select-selector') | Out-Null
Invoke-AgentBrowser -Arguments @(
    'wait',
    '--fn',
    "Array.from(document.querySelectorAll('.ant-select-item-option')).some(item=>{const rect=item.getBoundingClientRect();return item.getAttribute('title')==='备货管理'&&rect.width>0&&rect.height>0&&item.offsetParent!==null})"
) | Out-Null
$businessFunctions = @(
    '商品管理',
    '商品合规',
    '备货管理',
    '库存管理',
    '财务管理'
)
foreach ($businessFunction in $businessFunctions) {
    Select-VisibleDropdownOption -Title $businessFunction
}

$description = "本应用由$($pageState.subject)自研，计划服务同一公司主体旗下的全托管店铺，用于商品管理、商品合规、备货履约、库存管理、财务对账及内部BI经营分析。公司已有独立半托管应用；本应用仅用于全托管商家授权，按合作模式隔离数据和权限。所有写操作均执行权限校验、预检、人工确认、审计与结果回读。"
Invoke-AgentBrowser -Arguments @('fill', '#appDesc', $description) | Out-Null
Invoke-AgentBrowser -Arguments @('upload', '#iconUrl', $iconPath) | Out-Null
Invoke-AgentBrowser -Arguments @('wait', '--fn', "Array.from(document.images).some(img=>(img.currentSrc||img.src).startsWith('data:image/'))") | Out-Null

$validationRaw = Invoke-BrowserExpression -Expression "JSON.stringify({appName:document.querySelector('#appName')?.value||'',mode:Array.from(new Set((document.querySelector('#mode')?.closest('.ant-select')?.innerText||'').split(/\s+/).filter(Boolean))).join(''),business:Array.from(new Set((document.querySelector('#businessFunction')?.closest('.ant-select')?.innerText||'').split(/\s+/).filter(Boolean))),description:document.querySelector('#appDesc')?.value||'',iconPreview:Array.from(document.images).some(img=>(img.currentSrc||img.src).startsWith('data:image/')),submitDisabled:document.querySelector('button[type=submit]')?.disabled??Array.from(document.querySelectorAll('button')).find(b=>b.innerText.trim()==='提交审核')?.disabled??null})"
$validation = $validationRaw | ConvertFrom-Json
$expectedBusiness = @('商品管理', '商品合规', '备货管理', '库存管理', '财务管理')
$businessOk = (@($validation.business).Count -eq $expectedBusiness.Count) -and
    (@(Compare-Object -ReferenceObject $expectedBusiness -DifferenceObject @($validation.business)).Count -eq 0)

if ($validation.appName -ne $targetName -or
    $validation.mode -ne '全托管' -or
    -not $businessOk -or
    $validation.description -ne $description -or
    -not $validation.iconPreview) {
    throw "Prepared form validation failed for $store."
}

[pscustomobject]@{
    StoreKey = $store
    Port = $Port
    State = 'prepared'
    Subject = $pageState.subject
    SemiManagedApp = $semiApp.name
    TargetApp = $targetName
    CooperationMode = $validation.mode
    BusinessFunctions = @($validation.business)
    DescriptionLength = $validation.description.Length
    IconPath = $iconPath
    IconBytes = $iconInfo.Length
    IconPreview = [bool]$validation.iconPreview
    SubmitDisabled = $validation.submitDisabled
    CurrentUrl = Get-CurrentUrl
} | ConvertTo-Json -Depth 5
