"""Render a read-only note with the real offline reader, without a desktop window."""
from __future__ import annotations
import base64, hashlib, json, os, sys, time
from pathlib import Path

def preview(store, path_value, output_value, *, width=1200, height=900, heading=None, dark=False, snapshot_value=None):
    if not 320 <= width <= 2400 or not 240 <= height <= 2400:
        raise ValueError('Preview dimensions must be 320–2400 by 240–2400 pixels')
    source=store.resolve(path_value); output=store.resolve(output_value,must_exist=False)
    if output.suffix.lower()!='.png' or output.exists():raise ValueError('Choose a new .png output path')
    markdown,assets,_portable,raw=store._load(source)
    snapshot=None
    if snapshot_value:
        snapshot=json.loads(store.resolve(snapshot_value).read_text(encoding='utf-8'))
        from documents import bundle
        bundle(snapshot['content'],snapshot.get('assets',{}))
        markdown=snapshot['content'];assets=snapshot.get('assets',{})
    os.environ['QT_QPA_PLATFORM']='offscreen'
    os.environ.setdefault('QT_QUICK_BACKEND','software')
    flags=os.environ.get('QTWEBENGINE_CHROMIUM_FLAGS','')
    os.environ['QTWEBENGINE_CHROMIUM_FLAGS']=flags+' --disable-gpu'
    from PySide6.QtCore import QObject, Signal, Slot, QFile, QIODevice, QUrl, QTimer, Qt
    from PySide6.QtWidgets import QApplication
    from PySide6.QtWebEngineWidgets import QWebEngineView
    from PySide6.QtWebEngineCore import QWebEngineScript, QWebEngineSettings, QWebEnginePage, QWebEngineProfile
    from PySide6.QtWebChannel import QWebChannel
    from PySide6.QtGui import QFontDatabase
    from documents import MIMES, atomic_write
    root=Path(sys._MEIPASS)/'resources' if getattr(sys,'frozen',False) else Path(__file__).resolve().parent.parent
    reader=root/'dist'/'qt-reader.html'
    if not reader.is_file():raise ValueError('Build or install the offline reader before previewing notes')
    app=QApplication.instance() or QApplication(['Super MD headless preview'])
    for font in (root/'smd-core'/'fonts').glob('*.ttf'):QFontDatabase.addApplicationFont(str(font))
    view=QWebEngineView();view.resize(width,height);view.setAttribute(Qt.WA_DontShowOnScreen,True)
    profile=QWebEngineProfile(view);view.setPage(QWebEnginePage(profile,view))
    settings=view.settings();settings.setAttribute(QWebEngineSettings.LocalContentCanAccessRemoteUrls,False)
    settings.setAttribute(QWebEngineSettings.LocalContentCanAccessFileUrls,True)
    settings.setAttribute(QWebEngineSettings.JavascriptCanOpenWindows,False)
    state={'ready':False,'started':time.monotonic(),'error':None,'stable':0,'heading':False}
    payload={'id':'preview','path':str(source),'content':markdown,'mode':'reader','dark':dark,'font':'Manrope','size':18,'zoom':100,'widthPercent':94,'colors':{'surface':'#17131b' if dark else '#ffffff','primary':'#ffb38b' if dark else '#315d99','text':'#f6f0ee' if dark else '#20252d'},'svgAppearance':'auto','motion':False}
    if snapshot:payload.update({key:value for key,value in snapshot.get('view',{}).items() if key in ('dark','font','size','colors','svgAppearance','widthPercent','lineHeight')})
    class Bridge(QObject):
        replied=Signal(str,str,str)
        @Slot(str,str,str)
        def post(self,identifier,command,encoded):
            try:
                args=json.loads(encoded); result=True
                if command=='reader_ready':
                    state['ready']=True;view.page().runJavaScript('window.supermdLoad?.('+json.dumps(payload)+')')
                elif command in ('load_asset','load_text_asset'):
                    reference=args['source']
                    if reference in assets:result=assets[reference]
                    else:
                        local=store.resolve(source.parent/reference)
                        limit=2_000_000 if command=='load_text_asset' else 25_000_000
                        if local.stat().st_size>limit:raise ValueError('Preview asset exceeds its limit')
                        if command=='load_text_asset':result=local.read_text(encoding='utf-8')
                        else:
                            mime=MIMES.get(local.suffix.lstrip('.').lower())
                            if not mime:raise ValueError('Unsupported preview image')
                            result='data:'+mime+';base64,'+base64.b64encode(local.read_bytes()).decode()
                elif command=='load_python_output':result=None
                elif command=='resolve_reader_asset':raise ValueError('Use the bounded data loader for this preview')
                elif command in ('run_python','fetch_resource','document_changed','document_patch','save_media_native','copy_text','copy_image_native'):
                    raise ValueError('Headless preview is read-only and does not execute code or fetch remote media')
                self.replied.emit(identifier,json.dumps(result),'')
            except Exception as error:self.replied.emit(identifier,'null',str(error))
    bridge=Bridge();channel=QWebChannel(view.page());channel.registerObject('studio',bridge);view.page().setWebChannel(channel)
    script=QWebEngineScript();script.setName('Super MD WebChannel');script.setInjectionPoint(QWebEngineScript.DocumentCreation);script.setWorldId(QWebEngineScript.MainWorld)
    file=QFile(':/qtwebchannel/qwebchannel.js');file.open(QIODevice.ReadOnly);script.setSourceCode(bytes(file.readAll()).decode());view.page().scripts().insert(script)
    def fail(message):state['error']=message;app.exit(2)
    def inspected(result):
        if not result:return
        if heading and not state['heading']:
            state['heading']=True
            import unicodedata,re
            from agent_documents import _headings,resolve_heading
            try: title=resolve_heading(_headings(markdown,include_internal=True),heading)['title']
            except Exception as error:fail(str(error));return
            slug=re.sub(r'[^\w\s-]','',unicodedata.normalize('NFKC',title).lower()).strip()
            slug=re.sub(r'\s','-',slug) or 'section'
            view.page().runJavaScript('window.supermdHeading?.('+json.dumps(slug)+')')
            return
        state['stable']+=1
        if state['stable']<3:return
        timer.stop();image=view.grab().toImage()
        if image.isNull():fail('The offline reader did not produce pixels');return
        from PySide6.QtCore import QBuffer,QByteArray
        encoded=QByteArray();buffer=QBuffer(encoded);buffer.open(QIODevice.WriteOnly);image.save(buffer,'PNG')
        if source.read_bytes()!=raw:fail('The source changed during preview; retry');return
        with output.open('xb') as handle:handle.write(bytes(encoded))
        app.exit(0)
    def poll():
        if time.monotonic()-state['started']>40:timer.stop();fail('Offline reader preview timed out');return
        if state['ready']:view.page().runJavaScript("!!document.querySelector('.markdown-body') && document.fonts.status==='loaded' && [...document.images].every(i=>i.complete) && !document.querySelector('.mermaid-loading,.reader-loading')",inspected)
    timer=QTimer();timer.setInterval(150);timer.timeout.connect(poll);timer.start();view.load(QUrl.fromLocalFile(str(reader)));view.show()
    code=app.exec();view.close();view.deleteLater();app.processEvents()
    if code or state['error']:raise ValueError(state['error'] or 'Preview failed')
    return {'output':str(output),'width':width,'height':height,'renderer':'super-md-offline-reader','sourceUnchanged':True,'revision':hashlib.sha256(raw).hexdigest()}
