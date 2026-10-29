import json,time,hmac,hashlib,urllib.parse,urllib.request,urllib.error,uuid,os,subprocess
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:5180'
def auth(user=123456789):
 params={'query_id':'synthetic-query','signature':'test-only-signature','auth_date':str(int(time.time())),'user':json.dumps({'id':user,'first_name':'Studio'},separators=(',',':'))}
 check='\n'.join(f'{k}={v}' for k,v in sorted(params.items()));secret=hmac.new(b'WebAppData',b'123456789:TEST_ONLY_SYNTHETIC_TOKEN_NOT_A_CREDENTIAL',hashlib.sha256).digest();params['hash']=hmac.new(secret,check.encode(),hashlib.sha256).hexdigest();return urllib.parse.urlencode(params)
def call(path,method='GET',body=None,user=123456789):
 req=urllib.request.Request(BASE+path,method=method,headers={'Authorization':'tma '+auth(user),'Content-Type':'application/json'},data=json.dumps(body).encode() if body is not None else None)
 try:
  with urllib.request.urlopen(req,timeout=30) as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:return e.code,json.load(e)
def launch():return BASE+'/#'+urllib.parse.urlencode({'tgWebAppData':auth(),'tgWebAppVersion':'8.0','tgWebAppPlatform':'android','tgWebAppThemeParams':'{}'})
def saved(page):page.get_by_text('All changes saved',exact=False).wait_for(timeout=20000)
assert call('/api/status',user=222222222)[0]==403
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 for width,height in [(1440,1000),(390,844)]:
  context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:d.accept())
  page.goto(launch(),wait_until='networkidle');page.get_by_role('button',name='Posts',exact=True).first.click();page.get_by_role('button',name='Templates',exact=True).click();page.get_by_role('button',name='Use template',exact=True).first.click();page.get_by_label('Post title',exact=True).fill(f'Phase3 synthetic {width}');saved(page)
  page.get_by_role('button',name='Send Test Preview',exact=True).click();page.get_by_text('Private test preview confirmed',exact=False).wait_for();page.get_by_role('button',name='Publish Now',exact=True).click();page.get_by_text('Channel delivery confirmed',exact=False).wait_for()
  page.get_by_label('Schedule date and time').fill('2026-11-01T12:00');page.get_by_role('button',name='Schedule Post',exact=True).click();page.get_by_text('Schedule saved in UTC',exact=False).wait_for();page.screenshot(path=f'/workspace/k9-pb/docs/screenshots/phase3-editor-{width}.png',full_page=True)
  assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),width
  page.get_by_role('button',name='All drafts',exact=True).click();page.get_by_role('button',name='Published',exact=True).click();page.get_by_role('button',name='Manage publication',exact=True).first.click();page.get_by_role('button',name='Edit Published Post',exact=True).click();page.get_by_label('Post title',exact=True).fill(f'Phase3 edited {width}');saved(page);page.get_by_role('button',name='All drafts',exact=True).click();page.get_by_role('button',name='Published',exact=True).click();page.get_by_role('button',name='Manage publication',exact=True).first.click();page.get_by_role('button',name='Apply saved draft',exact=True).click();page.get_by_text('Telegram confirmed',exact=False).wait_for();page.get_by_role('button',name='Delete Telegram message',exact=True).click();page.get_by_text('Publication status:',exact=False).wait_for();page.get_by_text('deleted',exact=True).last.wait_for();page.get_by_label('Copy destination').select_option('23456789-1234-4234-8234-123456789012');page.get_by_role('button',name='Republish copy',exact=True).click();page.get_by_text('Telegram confirmed',exact=False).wait_for();page.screenshot(path=f'/workspace/k9-pb/docs/screenshots/phase3-published-{width}.png',full_page=True)
  page.get_by_role('button',name='Scheduled',exact=True).click();page.get_by_role('button',name='Reschedule',exact=True).first.click();page.get_by_label('New date and time').fill('2026-11-02T13:00');page.get_by_role('button',name='Save schedule',exact=True).click();page.get_by_role('button',name='Cancel schedule',exact=True).first.click();page.get_by_text('cancelled · cancelled',exact=True).wait_for();assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),width;assert not errors,errors;context.close();print('Browser workflows passed',width)
 browser.close()
# Python companion calls the real local Worker through signed API requests.
cli_env={**os.environ,'K9_API_URL':BASE,'K9_CLI_SECRET':'test_only_scoped_cli_secret_32_plus_characters'}
for cmd in ['doctor','status','channels','posts','scheduled']:
 r=subprocess.run(['python3','bot.py',cmd],env=cli_env,capture_output=True,text=True);assert r.returncode==0,(cmd,r.stderr)
post=call('/api/posts')[1]['posts'][0];pid=post['id'];channel='23456789-1234-4234-8234-123456789012'
for args in [['preview',pid],['publish',pid,channel]]:
 r=subprocess.run(['python3','bot.py',*args],env=cli_env,capture_output=True,text=True);assert r.returncode==0,(args,r.stdout,r.stderr)
run_at='2026-11-03T05:30:00.000Z';code,result=call('/api/posts/'+pid+'/schedule','POST',{'operationId':str(uuid.uuid4()),'revision':post['revision'],'channelId':channel,'runAt':run_at,'timezone':'Asia/Yangon'});assert code==201,(code,result)
with urllib.request.urlopen(BASE+'/__qa/cron') as r:assert json.load(r)['ok']
job=next(j for j in call('/api/scheduled')[1]['jobs'] if j['id']==result['job']['id']);assert job['status']=='succeeded',job
with urllib.request.urlopen(BASE+'/__qa/stats') as r:print('Real local Worker/D1 + mock Telegram counters',json.load(r))
print('Python commands and cron delivery passed; no real Telegram calls made')
