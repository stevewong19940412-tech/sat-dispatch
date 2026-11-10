import time, re
content = open('client/index.html').read()
stamp = str(int(time.time()))
content = re.sub(r'(<meta name="build-stamp" content=")\d+(")', r'\g<1>' + stamp + r'\g<2>', content)
content = re.sub(r'(<title>)\[B\d+\] ', r'\g<1>[B' + stamp[-4:] + '] ', content)
open('client/index.html','w').write(content)
print('stamp →', stamp)
