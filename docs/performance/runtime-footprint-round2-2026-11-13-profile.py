import os,sys,time,json,tempfile,subprocess,pathlib,signal,socket,struct
# Match the target bundle: historical baseline 1, current protocol after #831 2.
compatibility_version=int(os.environ.get('RAM2_COMPATIBILITY_VERSION','1'))
class RPC:
 def __init__(self,endpoint):
  self.s=socket.socket(socket.AF_UNIX);self.s.settimeout(60);self.s.connect(endpoint);self.id=0
  self.send({'t':'hello','version':'2.1.0-beta.14','compatibilityVersion':compatibility_version,'client':{'clientId':'profile','device':{'name':'profile','publicKey':''},'features':[]}})
  assert self.recv()['t']=='hello'
 def send(self,msg):
  body=b'\0'+json.dumps(msg).encode();self.s.sendall(struct.pack('>I',len(body))+body)
 def recv(self):
  def read(n):
   b=b''
   while len(b)<n:
    a=self.s.recv(n-len(b))
    if not a:raise EOFError()
    b+=a
   return b
  n=struct.unpack('>I',read(4))[0];b=read(n)
  return json.loads(b[1:]) if b[0]==0 else {'binary':len(b)}
 def call(self,cap,method,params=None):
  self.id+=1;start=time.monotonic();self.send({'t':'req','id':self.id,'cap':cap,'method':method,'params':params,'opId':f'profile:{self.id}'})
  while True:
   m=self.recv()
   if m.get('t')=='res' and m['id']==self.id:
    if 'error' in m:raise RuntimeError(str(m))
    return {'ms':(time.monotonic()-start)*1000,'result':m.get('result')}

lock=pathlib.Path('/private/tmp/cate-ram-round2-profile.lock'); owner={'track':'runtime-footprint','pid':os.getpid()}
for attempt in range(13):
 try: lock.mkdir(); break
 except FileExistsError:
  if attempt==12: raise SystemExit('lock busy')
  time.sleep(5)
(lock/'owner.json').write_text(json.dumps(owner))
workspace_count=int(os.environ.get('RAM2_WORKSPACES','10'))
procs=[]; clients=[]; active_mode='--active' in sys.argv; result={'label':sys.argv[1],'samples':[]}
base=pathlib.Path(tempfile.mkdtemp(prefix='cate-ram2-',dir='/private/tmp')); result['fixture']=str(base)
result['cohort']='active' if active_mode else 'empty-then-active'
result['hostVmStat']=subprocess.check_output(['vm_stat'],text=True)
result['nodeVersion']=subprocess.check_output([os.environ.get('RAM2_NODE','/opt/homebrew/opt/node@22/bin/node'),'--version'],text=True).strip()
def exercise(j):
 info=json.loads(next((base/f'h{j}').glob('.cate/workspaces/*/runtime.json')).read_text())
 c=RPC(info['endpoints']['local']);clients.append(c)
 latency={}
 for cap,method,params in [('workspace','setTrust',{'trusted':True}),('file','read',{'path':str(base/f'p{j}'/'notes.txt')}),('vcs','readStatus',{}),('agents','setupInspect',{}),('process','spawn',{'cols':100,'rows':30,'shell':'/bin/sh','launch':{'kind':'command','params':{'executable':'/bin/sh','args':['-c','while :; do echo round2-working; sleep 1; done']}}})]:
  latency[cap]=c.call(cap,method,params)
 result.setdefault('firstUse',[]).append(latency)

try:
 for i in range(workspace_count):
  home=base/f'h{i}'; root=base/f'p{i}'; home.mkdir(); root.mkdir()
  subprocess.run(['git','init','-q',str(root)],check=True)
  (root/'notes.txt').write_text('round two\n')
  env={**os.environ,'HOME':str(home),'SHELL':'/bin/sh','RAM2_SAMPLE':str(base/f'sample{i}.json')}
  start=time.monotonic()
  p=subprocess.Popen([os.environ.get('RAM2_NODE', '/opt/homebrew/opt/node@22/bin/node'),'--require',str(pathlib.Path(__file__).with_name('runtime-footprint-round2-2026-11-13-preload.cjs')),sys.argv[2],'serve',str(root)],env=env,stdout=open(base/f'out{i}','w'),stderr=subprocess.STDOUT); procs.append(p)
  for _ in range(200):
   infos=list(home.glob('.cate/workspaces/*/runtime.json'))
   if infos:
    try:
     sock=socket.socket(socket.AF_UNIX);sock.settimeout(.3);sock.connect(json.loads(infos[0].read_text())['endpoints']['local'])
     body=b'\0'+json.dumps({'t':'hello','version':'2.1.0-beta.14','compatibilityVersion':compatibility_version,'client':{'clientId':'profile','device':{'name':'profile','publicKey':''},'features':[]}}).encode()
     sock.sendall(struct.pack('>I',len(body))+body)
     if sock.recv(4096): break
    except (OSError,KeyError): pass
    finally: sock.close()
   if p.poll() is not None: raise RuntimeError((base/f'out{i}').read_text())
   time.sleep(.05)
  else: raise RuntimeError('runtime did not answer hello within startup budget')
  result.setdefault('startupMs',[]).append((time.monotonic()-start)*1000)
  if active_mode: exercise(i)
  if i+1 in {1,min(5,workspace_count),workspace_count}:
   time.sleep(3)
   rows=[]
   for j,p in enumerate(procs):
    p.send_signal(signal.SIGUSR2); time.sleep(.1)
    row=json.loads((base/f'sample{j}.json').read_text()); row['pid']=p.pid
    row['psRssKiB']=int(subprocess.check_output(['ps','-o','rss=','-p',str(p.pid)]))
    row['footprint']=subprocess.run(['/usr/bin/footprint','-f','bytes','-p',str(p.pid)],capture_output=True,text=True).stdout
    if j==0:
     row['vmmap']=subprocess.run(['/usr/bin/vmmap','-summary',str(p.pid)],capture_output=True,text=True).stdout
    rows.append(row)
   result['samples'].append({'count':i+1,'stage':'running-terminals' if active_mode else 'empty','processes':rows})
 # Exercise each still-live runtime over its actual protocol socket.
 if not active_mode:
  for j in range(workspace_count): exercise(j)
 time.sleep(5)
 rows=[]
 for j,p in enumerate(procs):
  p.send_signal(signal.SIGUSR2);time.sleep(.1)
  row=json.loads((base/f'sample{j}.json').read_text());row['pid']=p.pid
  row['psRssKiB']=int(subprocess.check_output(['ps','-o','rss=','-p',str(p.pid)]))
  row['footprint']=subprocess.run(['/usr/bin/footprint','-f','bytes','-p',str(p.pid)],capture_output=True,text=True).stdout
  rows.append(row)
 result['samples'].append({'count':workspace_count,'stage':'running-terminals','processes':rows})
 c=clients[0]; late={}
 # Load an actual Yjs buffer and cancel its subscription after initial sync.
 c.id+=1;stream=c.id;start=time.monotonic()
 c.send({'t':'req','id':stream,'cap':'file','method':'buffer','params':{'path':str(base/'p0'/'notes.txt')}})
 while True:
  msg=c.recv()
  if msg.get('t')=='res' and msg.get('error'):raise RuntimeError(str(msg))
  if msg.get('t')=='evt' and msg.get('data',{}).get('kind')=='sync':break
 c.send({'t':'cancel','id':stream});late['bufferMs']=(time.monotonic()-start)*1000
 for cap,method,params in [('browserData','passwordSuggestions',{'url':'https://example.com'}),('agents','usage',{'sinceDay':'2026-11-13','untilDay':'2026-11-14'}),('skills','index',{}),('settings','set',{'key':'runtimeNetwork','value':'sameNetwork'}),('pairing','createSecret',{'mode':'sameNetwork','acknowledged':True})]:
  r=c.call(cap,method,params)
  late[cap]={'ms':r['ms'],'resultType':type(r['result']).__name__}
  if isinstance(r['result'],list):late[cap]['count']=len(r['result'])
 time.sleep(3);p=procs[0];p.send_signal(signal.SIGUSR2);time.sleep(.1)
 row=json.loads((base/'sample0.json').read_text());row['pid']=p.pid
 row['footprint']=subprocess.run(['/usr/bin/footprint','-f','bytes','-p',str(p.pid)],capture_output=True,text=True).stdout
 row['vmmap']=subprocess.run(['/usr/bin/vmmap','-summary',str(p.pid)],capture_output=True,text=True).stdout
 result['samples'].append({'count':1,'stage':'all-optional-first-use','processes':[row]});result['optionalFirstUse']=late

 p.send_signal(signal.SIGURG);time.sleep(.2)
 result['nativeMappingsAfterFirstUse']=json.loads((base/'sample0.json.modules').read_text())
 for c in clients:c.s.close()

finally:
 for p in procs:
  if p.poll() is None: p.terminate()
 for p in procs:
  try:p.wait(timeout=8)
  except subprocess.TimeoutExpired:p.kill();p.wait()
 try:
  pathlib.Path(sys.argv[3]).write_text(json.dumps(result,indent=2))
 finally:
  if json.loads((lock/'owner.json').read_text())==owner:
   (lock/'owner.json').unlink();lock.rmdir()
