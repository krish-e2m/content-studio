import { useRef, useState } from 'react'
import { motion } from 'motion/react'
import { Icon } from '../icons.jsx'
import { Modal } from './Modal.jsx'
import { Markdown } from './Markdown.jsx'
import { updateClient, draftBrandFiles } from '../api.js'

const panelV = {
  hidden: { opacity: 0, y: 14, filter: 'blur(8px)' },
  show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.36, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, y: -12, filter: 'blur(8px)', transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } },
}

// strip the markdown extension → a human document name
const nameFromFile = (filename) => String(filename || '').replace(/\.(md|markdown)$/i, '').trim()

// first meaningful line of the doc, with markdown markers stripped → a one-line
// preview shown next to the name in the list.
const snippet = (content) => {
  const line = String(content || '')
    .split('\n')
    .map((l) => l.replace(/^[#>\-*\s`]+/, '').trim())
    .find(Boolean) || 'Empty document'
  return line.length > 100 ? `${line.slice(0, 100)}…` : line
}

// Self-contained Brand-documents manager: lists the client's markdown docs and
// owns its own add / edit / delete flow (saves straight to the `documents`
// column via PATCH, independent of the page's global edit/save).
const UNTAGGED = 'Untagged'
// A folder name maps back to the stored `tag`. The "Untagged" folder is the
// home for docs with no tag, so adding into it leaves the tag empty.
const tagForFolder = (folder) => (folder && folder !== UNTAGGED ? folder : '')

// Predefined folders, always shown for every client (even when empty). They
// mirror the layered "brand brain" workspace the generation engine (engine.js)
// uses: every folder can feed the writer (within a prompt budget). Voice/rules
// in `core` win first; `skills` are writing playbooks (and in agentic mode are
// also mounted as .claude/skills); audience/offers/proof/research/custom
// folders are reference material ranked by relevance. Huge project plans still
// fit — they just get truncated or name-only if the budget is tight.
const DEFAULT_FOLDERS = [
  { name: 'core', desc: 'Brand essentials — always preferred by the AI writer' },
  { name: 'skills', desc: 'Writing playbooks (hooks, formats). Prefer research/ for long project plans' },
  { name: 'audience', desc: 'Personas, segments and who we speak to' },
  { name: 'offers', desc: 'Products, services, pricing and promos' },
  { name: 'proof', desc: 'Testimonials, case studies and results' },
  { name: 'research', desc: 'Market notes, competitors, plans and inspiration' },
  { name: 'assets', desc: 'Logos, image links and asset usage notes' },
]

export function BrandDocuments({ client, onSaved }) {
  const docs = Array.isArray(client.documents) ? client.documents : []

  const [picking, setPicking] = useState(null)         // null | { folder } - Manual vs Upload chooser
  const [editor, setEditor] = useState(null)           // { index: number|null, name, content, tag }
  const [viewing, setViewing] = useState(null)         // index being read (rendered .md)
  const [subTab, setSubTab] = useState('write')        // 'write' | 'preview'
  const [confirming, setConfirming] = useState(null)   // index pending delete
  const [expanded, setExpanded] = useState(() => new Set())  // folder names folded open (all start collapsed)
  const [creating, setCreating] = useState(false)      // new-folder modal open?
  const [newName, setNewName] = useState('')           // new folder's name (being typed)
  const [newFolders, setNewFolders] = useState([])     // locally-made folders awaiting their first doc
  const [busy, setBusy] = useState(false)
  const [drafting, setDrafting] = useState(false)  // "Draft core files" in flight
  const [note, setNote] = useState('')             // success note after drafting
  const [err, setErr] = useState('')
  const fileRef = useRef(null)

  // Draft the starter core/*.md docs from the structured brand guideline
  // (server-side templating - never overwrites existing documents).
  const draftCore = async () => {
    setDrafting(true); setErr(''); setNote('')
    try {
      const { client: updated, added } = await draftBrandFiles(client.id)
      if (added > 0) onSaved?.(updated)
      setNote(added > 0
        ? `Drafted ${added} core document${added === 1 ? '' : 's'} from the brand guideline - review & enrich them.`
        : 'Core documents already exist - nothing new to draft.')
    } catch (e) { setErr(e.message || 'Drafting failed') } finally { setDrafting(false) }
  }

  // pre-seed the new doc's folder (tag) from wherever "Add" was clicked
  const openManual = () => { const tag = tagForFolder(picking?.folder); setPicking(null); setErr(''); setSubTab('write'); setEditor({ index: null, name: '', content: '', tag }) }
  const openEdit = (i) => { setErr(''); setSubTab('write'); setEditor({ index: i, name: docs[i].name || '', content: docs[i].content || '', tag: docs[i].tag || '' }) }
  const triggerUpload = () => fileRef.current?.click()
  const toggleFolder = (folder) => setExpanded((prev) => {
    const next = new Set(prev)
    next.has(folder) ? next.delete(folder) : next.add(folder)
    return next
  })
  const openCreateFolder = () => { setErr(''); setNewName(''); setCreating(true) }

  // Upload flow: .md only, name auto-detected from the filename. We read the
  // file text client-side and drop the user into the editor to review & save
  // (content lives in the DB, not storage - so there's nothing to upload).
  const onFile = async (e) => {
    const file = (e.target.files || [])[0]
    e.target.value = ''
    if (!file) return
    if (!/\.(md|markdown)$/i.test(file.name)) { setErr('Only .md files are allowed.'); return }
    const tag = tagForFolder(picking?.folder)
    try {
      const content = await file.text()
      setPicking(null); setErr(''); setSubTab('preview')
      setEditor({ index: null, name: nameFromFile(file.name), content, tag })
    } catch { setErr('Could not read that file.') }
  }

  const persist = async (next) => {
    const updated = await updateClient(client.id, { documents: next })
    onSaved?.(updated)
    return updated
  }

  const save = async () => {
    const name = editor.name.trim()
    if (!name) { setErr('Give the document a name.'); return }
    if (!editor.content.trim()) { setErr('The document has no content yet.'); return }
    setBusy(true); setErr('')
    const row = { name, content: editor.content, tag: editor.tag.trim() }
    const next = editor.index == null
      ? [...docs, row]
      : docs.map((d, i) => (i === editor.index ? row : d))
    try {
      await persist(next)
      setEditor(null)
    } catch (e) { setErr(e.message || 'Save failed') } finally { setBusy(false) }
  }

  const remove = async (i) => {
    setBusy(true); setErr('')
    try {
      await persist(docs.filter((_, j) => j !== i))
      setConfirming(null)
    } catch (e) { setErr(e.message || 'Delete failed') } finally { setBusy(false) }
  }

  // group docs into folders (by tag), keeping each doc's original index
  // (edit/view/delete operate on that index). The Untagged folder sorts last.
  const groups = {}
  docs.forEach((doc, i) => { (groups[(doc.tag || '').trim() || UNTAGGED] ||= []).push({ doc, i }) })
  // A predefined folder adopts an existing tag's casing if one matches (a doc
  // tagged "Core" groups under that name rather than a duplicate "core").
  const groupKeys = Object.keys(groups)
  const canon = (name) => groupKeys.find((k) => k.toLowerCase() === name.toLowerCase()) || name
  const defaultNames = DEFAULT_FOLDERS.map((f) => canon(f.name))
  const isDefault = (name) => defaultNames.some((d) => d.toLowerCase() === String(name).toLowerCase())
  const descFor = (name) => DEFAULT_FOLDERS.find((f) => f.name.toLowerCase() === String(name).toLowerCase())?.desc || ''
  // folders shown = the predefined set (always, in its own order), then folders
  // with docs plus empty ones the user just made, alphabetical, Untagged last.
  const customFolders = [...new Set([...groupKeys, ...newFolders])]
    .filter((f) => !isDefault(f))
    .sort((a, b) => (a === UNTAGGED ? 1 : b === UNTAGGED ? -1 : a.localeCompare(b)))
  const folderNames = [...new Set([...defaultNames, ...customFolders])]
  // folder suggestions in the editor's datalist: predefined + in-use tags
  const allFolders = [...new Set([...defaultNames, ...docs.map((d) => (d.tag || '').trim()).filter(Boolean)])]
    .sort((a, b) => a.localeCompare(b))

  // create an empty folder locally; it shows in the tree right away
  const createFolder = () => {
    const name = newName.trim()
    if (!name) { setErr('Give the folder a name.'); return }
    if (name.toLowerCase() === UNTAGGED.toLowerCase()) { setErr(`"${UNTAGGED}" is reserved.`); return }
    if (folderNames.some((f) => f.toLowerCase() === name.toLowerCase())) { setErr('That folder already exists.'); return }
    setNewFolders((prev) => [...prev, name])
    setExpanded((prev) => new Set(prev).add(name))  // a just-made folder starts open
    setCreating(false); setNewName(''); setErr('')
  }

  const docRow = (doc, i) => (
    <div className="doc-row" key={i}>
      <span className="doc-row-ico"><Icon.Layers width={16} height={16} /></span>
      <button className="doc-row-main" onClick={() => setViewing(i)} title="View document">
        <span className="doc-row-name">{doc.name}</span>
        <span className="doc-row-meta">{snippet(doc.content)}</span>
      </button>
      <span className="pill">.md</span>
      <div className="doc-row-actions">
        <button className="btn btn-ghost btn-sm" onClick={() => setViewing(i)}><Icon.Eye width={14} height={14} /> View</button>
        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(i)}><Icon.Pen width={14} height={14} /> Edit</button>
        <button className="btn btn-ghost btn-sm doc-row-del" onClick={() => setConfirming(i)} aria-label="Delete document"><Icon.Trash width={15} height={15} /></button>
      </div>
    </div>
  )

  return (
    <motion.div key="documents" variants={panelV} initial="hidden" animate="show" exit="exit">
      <input ref={fileRef} type="file" hidden accept=".md,.markdown,text/markdown" onChange={onFile} />

      <div className="docs-head">
        <div><span className="bp-eyebrow">Brand documents</span><h2 className="bp-title">{docs.length} document{docs.length === 1 ? '' : 's'} · {folderNames.length} folder{folderNames.length === 1 ? '' : 's'}</h2></div>
        <span className="row" style={{ gap: 10 }}>
          <button className="btn btn-ghost btn-sm" onClick={draftCore} disabled={drafting}><Icon.Spark width={13} height={13} /> {drafting ? 'Drafting…' : 'Draft core files'}</button>
          <button className="btn btn-rose btn-sm" onClick={openCreateFolder}><Icon.Plus width={14} height={14} /> Add folder</button>
        </span>
      </div>
      <div className="docs-tree">
        {folderNames.map((folder) => {
          const open = expanded.has(folder)
          const items = groups[folder] || []
          const desc = descFor(folder)
          return (
            <div className={`docs-folder ${open ? 'open' : ''}`} key={folder}>
              <div className="docs-folder-head">
                <button className="docs-folder-toggle" onClick={() => toggleFolder(folder)} aria-expanded={open} title={open ? 'Collapse folder' : 'Expand folder'}>
                  <span className="docs-folder-chev"><Icon.Chevron width={14} height={14} /></span>
                  <span className="docs-folder-ico">{open ? <Icon.FolderOpen width={18} height={18} /> : <Icon.Folder width={18} height={18} />}</span>
                  <span className="docs-folder-name">{folder}</span>
                  <span className="docs-folder-count">{items.length}</span>
                  {desc && <span className="docs-folder-desc">{desc}</span>}
                </button>
                <button className="btn btn-ghost btn-sm docs-folder-add" onClick={() => setPicking({ folder })} title={`Add a document to ${folder}`}><Icon.Plus width={13} height={13} /> Add doc</button>
              </div>
              {open && (
                <div className="docs-folder-body">
                  {items.length === 0 ? (
                    <button className="docs-folder-empty" onClick={() => setPicking({ folder })}>
                      <Icon.Plus width={13} height={13} /> Empty folder - add a document
                    </button>
                  ) : (
                    <div className="docs-list">
                      {items.map(({ doc, i }) => docRow(doc, i))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {err && !editor && !creating && <div className="lock-note" style={{ marginTop: 16 }}>{err}</div>}
      {note && !err && <div className="ob-hint" style={{ marginTop: 16 }}>{note}</div>}

      {/* choose: manual or upload */}
      {picking && (
        <Modal
          title="Add a brand document"
          sub={tagForFolder(picking.folder) ? `New document in "${picking.folder}". Write it in markdown, or upload a .md file.` : 'Write it in markdown, or upload a .md file.'}
          onClose={() => setPicking(null)}
        >
          <div className="bp-choose">
            <button className="bp-choose-card" onClick={openManual}>
              <span className="bp-choose-ico"><Icon.Pen width={20} height={20} /></span>
              <span className="bp-choose-name">Manual</span>
              <span className="bp-choose-desc">Give it a name and write the content in markdown - preview as you go.</span>
            </button>
            <button className="bp-choose-card" onClick={triggerUpload}>
              <span className="bp-choose-ico"><Icon.Layers width={20} height={20} /></span>
              <span className="bp-choose-name">Upload .md</span>
              <span className="bp-choose-desc">Pick a markdown file - the name is detected from the filename.</span>
            </button>
          </div>
        </Modal>
      )}

      {/* create a new (empty) folder */}
      {creating && (
        <Modal title="New folder" sub="Group this brand's documents under a folder, then add documents to it." onClose={() => { setCreating(false); setErr('') }}>
          <div className="stack">
            <div>
              <span className="label">Folder name</span>
              <input
                className="field"
                autoFocus
                value={newName}
                placeholder="e.g. Guidelines"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createFolder()}
              />
            </div>
            {err && <div className="lock-note">{err}</div>}
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => { setCreating(false); setErr('') }}>Cancel</button>
              <button className="btn btn-rose" onClick={createFolder}><Icon.Plus width={14} height={14} /> Create folder</button>
            </div>
          </div>
        </Modal>
      )}

      {/* read-only view: rendered markdown */}
      {viewing != null && docs[viewing] && (
        <Modal wide title={docs[viewing].name} sub={`${docs[viewing].tag ? `${docs[viewing].tag} · ` : ''}.md document`} onClose={() => setViewing(null)}>
          <Markdown source={docs[viewing].content} className="doc-view" />
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setViewing(null)}>Close</button>
            <button className="btn btn-rose" onClick={() => { const i = viewing; setViewing(null); openEdit(i) }}><Icon.Pen width={14} height={14} /> Edit</button>
          </div>
        </Modal>
      )}

      {/* manual editor (also used for edit + upload review) */}
      {editor && (
        <Modal
          wide
          title={editor.index == null ? 'New document' : 'Edit document'}
          sub="Content is markdown. Switch to Preview to see it rendered."
          onClose={() => { setEditor(null); setErr('') }}
        >
          <div className="stack">
            <div className="doc-meta-row">
              <div>
                <span className="label">Document name</span>
                <input
                  className="field"
                  autoFocus
                  value={editor.name}
                  placeholder="e.g. Content style guide"
                  onChange={(e) => setEditor((x) => ({ ...x, name: e.target.value }))}
                />
              </div>
              <div>
                <span className="label">Folder</span>
                <input
                  className="field"
                  list="doc-folders"
                  value={editor.tag}
                  placeholder="e.g. Guidelines"
                  onChange={(e) => setEditor((x) => ({ ...x, tag: e.target.value }))}
                />
                <datalist id="doc-folders">
                  {allFolders.map((t) => <option key={t} value={t} />)}
                </datalist>
              </div>
            </div>

            <div>
              <span className="label">Content</span>
              <div className="seg-tabs" style={{ marginTop: 6 }}>
                <button className={`seg-tab ${subTab === 'write' ? 'on' : ''}`} onClick={() => setSubTab('write')}><Icon.Pen width={13} height={13} /> Markdown</button>
                <button className={`seg-tab ${subTab === 'preview' ? 'on' : ''}`} onClick={() => setSubTab('preview')}><Icon.Eye width={13} height={13} /> Preview</button>
              </div>
              {subTab === 'write' ? (
                <textarea
                  className="field md-write"
                  value={editor.content}
                  placeholder={'# Heading\n\nWrite the document in **markdown**…'}
                  onChange={(e) => setEditor((x) => ({ ...x, content: e.target.value }))}
                />
              ) : editor.content.trim() ? (
                <div className="md-preview"><Markdown source={editor.content} /></div>
              ) : (
                <div className="md-preview md-preview-empty">Nothing to preview yet.</div>
              )}
            </div>

            {err && <div className="lock-note">{err}</div>}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => { setEditor(null); setErr('') }} disabled={busy}>Cancel</button>
              <button className="btn btn-rose" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save document'}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* delete confirm */}
      {confirming != null && (
        <Modal title="Delete document?" sub={`"${docs[confirming]?.name}" will be removed from this brand.`} onClose={() => setConfirming(null)}>
          {err && <div className="lock-note" style={{ marginBottom: 12 }}>{err}</div>}
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirming(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-rose" onClick={() => remove(confirming)} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</button>
          </div>
        </Modal>
      )}
    </motion.div>
  )
}
