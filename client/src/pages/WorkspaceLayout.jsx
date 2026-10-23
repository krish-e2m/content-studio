import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { TopNav } from '../components/TopNav.jsx'
import { GeneratePostModal } from '../components/GeneratePostModal.jsx'
import { useClients } from '../context/ClientsContext.jsx'
import { listIdeas, createIdea as apiCreateIdea, updateIdea as apiUpdateIdea, deleteIdea as apiDeleteIdea, listPhotos, uploadPhoto as apiUploadPhoto, deletePhoto as apiDeletePhoto, reorderPhotos as apiReorderPhotos, saveGeneratedImage as apiSaveGeneratedImage, listResearchTopics, createResearchTopic as apiCreateResearchTopic, deleteResearchTopic as apiDeleteResearchTopic, updateResearchTopic as apiUpdateResearchTopic, suggestResearchIdeas as apiSuggestResearchIdeas, listPosts, savePostBatch as apiSavePostBatch, deletePost as apiDeletePost, updatePost as apiUpdatePost } from '../api.js'

const CRUMBS = { '': 'Overview', research: 'Research', ideas: 'Idea Bank', posts: 'Posts', photos: 'Photo Library', calendar: 'Content Calendar', performance: 'Performance' }

// Route element: resolves the client from the URL, then mounts the shell keyed
// by client id so all per-client state resets cleanly when switching clients.
export default function WorkspaceLayout() {
  const { clientId } = useParams()
  const { clients } = useClients()
  const client = clients.find((c) => String(c.id) === String(clientId))
  if (!client) return <Navigate to="/" replace />
  return <WorkspaceShell key={client.id} client={client} />
}

function WorkspaceShell({ client }) {
  const navigate = useNavigate()
  const location = useLocation()

  // Photos live in the database + Storage (scoped to this client). Load them
  // once on mount; add/remove below persist through the API and keep this in sync.
  const [photos, setPhotos] = useState([])
  const [photosReady, setPhotosReady] = useState(false)
  useEffect(() => {
    let alive = true
    listPhotos(client.id)
      .then((rows) => alive && setPhotos(rows))
      .catch(() => alive && flash('Could not load photos from the server'))
      .finally(() => alive && setPhotosReady(true))
    return () => { alive = false }
  }, [client.id])

  // Ideas live in the database (scoped to this client). Load them once on mount;
  // add/remove below persist through the API and keep this list in sync.
  const [ideas, setIdeas] = useState([])
  const [ideasReady, setIdeasReady] = useState(false)
  useEffect(() => {
    let alive = true
    listIdeas(client.id)
      .then((rows) => alive && setIdeas(rows))
      .catch(() => alive && flash('Could not load ideas from the server'))
      .finally(() => alive && setIdeasReady(true))
    return () => { alive = false }
  }, [client.id])

  // Research topics (Manual tab) also live in the database, scoped to this
  // client. Load once on mount; add/remove below persist through the API.
  const [researchTopics, setResearchTopics] = useState([])
  const [researchReady, setResearchReady] = useState(false)
  useEffect(() => {
    let alive = true
    listResearchTopics(client.id)
      .then((rows) => alive && setResearchTopics(rows))
      .catch(() => alive && flash('Could not load research topics from the server'))
      .finally(() => alive && setResearchReady(true))
    return () => { alive = false }
  }, [client.id])

  // All posts (every platform row) for this client, powering the Posts tab.
  // null = still loading. Reloaded after the generate modal schedules new posts.
  const [posts, setPosts] = useState(null)
  const reloadPosts = () => listPosts(client.id).then(setPosts).catch(() => setPosts([]))
  useEffect(() => {
    let alive = true
    listPosts(client.id)
      .then((rows) => alive && setPosts(rows))
      .catch(() => alive && setPosts([]))
    return () => { alive = false }
  }, [client.id])

  // The idea currently being turned into content in the GeneratePostModal
  // (null = closed). Holds { idea, ...opts }. Any page opens it via startFromIdea.
  const [generateIdea, setGenerateIdea] = useState(null)
  const [wantNewIdea, setWantNewIdea] = useState(false)
  const [toast, setToast] = useState('')

  const flash = (msg) => {
    setToast(msg)
    window.clearTimeout(flash._t)
    flash._t = window.setTimeout(() => setToast(''), 2400)
  }

  // Turn an idea into content: open the generate modal (no page navigation).
  // The modal handles both the plain and image-grounded generation paths and
  // schedules the resulting posts straight into the posts table. `opts` lets the
  // Add-idea "Create content" flow pass a chosen content type + image and skip
  // the modal's type stage (autoStart). When called without opts (the row
  // "Create" button), reuse the content type / image saved on the idea so it
  // generates straight away instead of re-asking.
  const startFromIdea = (idea, opts = {}) => {
    if (Object.keys(opts).length) return setGenerateIdea({ idea, ...opts })
    const formatByPlat = idea.contentType || {}
    const imagePhotos = Array.isArray(idea.refImages) ? idea.refImages : []
    if (imagePhotos.length || Object.keys(formatByPlat).length)
      return setGenerateIdea({ idea, formatByPlat, imagePhotos, autoStart: true })
    setGenerateIdea({ idea })
  }
  const closeGenerate = () => setGenerateIdea(null)

  // Topbar "New idea" action: route to the Idea Bank and flag intent so the page
  // opens its add-idea modal. IdeaBankPage consumes and clears the flag on mount.
  const openNewIdea = () => {
    setWantNewIdea(true)
    navigate(`/clients/${client.id}/ideas`)
  }
  const clearNewIdea = () => setWantNewIdea(false)

  // Persist a new idea, then prepend the saved row (with its DB id) to the list.
  // Throws on failure so callers can surface their own message.
  const addIdea = async (idea) => {
    const saved = await apiCreateIdea(client.id, idea)
    setIdeas((arr) => [saved, ...arr])
    return saved
  }

  // Persist edits to an existing idea, then swap the updated row in place.
  const updateIdea = async (id, idea) => {
    const saved = await apiUpdateIdea(client.id, id, idea)
    setIdeas((arr) => arr.map((i) => (i.id === id ? saved : i)))
    return saved
  }

  // Optimistically drop the row, then delete server-side; reload if it fails.
  const removeIdea = async (id) => {
    const prev = ideas
    setIdeas((arr) => arr.filter((i) => i.id !== id))
    try {
      await apiDeleteIdea(client.id, id)
    } catch {
      setIdeas(prev)
      flash('Could not remove the idea')
    }
  }

  // Upload a photo, then prepend the saved row (with its DB id + URL) to the
  // list. Throws on failure so the page can surface its own message.
  const addPhoto = async (file, title) => {
    const saved = await apiUploadPhoto(client.id, file, title)
    setPhotos((arr) => [saved, ...arr])
    return saved
  }

  // Persist an AI-generated image (a data-URL) into the library, then prepend
  // the saved row. Throws on failure so the studio can surface its own message.
  const addGeneratedPhoto = async ({ dataUrl, title, prompt }) => {
    const saved = await apiSaveGeneratedImage(client.id, { dataUrl, title, prompt })
    setPhotos((arr) => [saved, ...arr])
    return saved
  }

  // Optimistically drop the photo, then delete server-side; restore if it fails.
  const removePhoto = async (id) => {
    const prev = photos
    setPhotos((arr) => arr.filter((p) => p.id !== id))
    try {
      await apiDeletePhoto(client.id, id)
    } catch {
      setPhotos(prev)
      flash('Could not remove the photo')
    }
  }

  // Bulk delete: optimistically drop all selected photos in one pass, delete
  // them server-side in parallel, and restore the whole set if any call fails.
  const removePhotos = async (ids) => {
    if (!ids?.length) return
    const set = new Set(ids)
    const prev = photos
    setPhotos((arr) => arr.filter((p) => !set.has(p.id)))
    try {
      await Promise.all(ids.map((id) => apiDeletePhoto(client.id, id)))
    } catch {
      setPhotos(prev)
      flash('Could not remove some photos')
    }
  }

  // Persist a drag-reordered photo list: apply the new order optimistically,
  // then save it server-side (position = index); restore on failure.
  const reorderPhotos = async (orderedIds) => {
    if (!orderedIds?.length) return
    const byId = new Map(photos.map((p) => [p.id, p]))
    const next = orderedIds.map((id) => byId.get(id)).filter(Boolean)
    const prev = photos
    setPhotos(next)
    try {
      await apiReorderPhotos(client.id, orderedIds)
    } catch {
      setPhotos(prev)
      flash('Could not save the new order')
    }
  }

  // Persist a new research topic, then prepend the saved row (with its DB id).
  // Throws on failure so the page can surface its own message.
  const addResearchTopic = async (text) => {
    const saved = await apiCreateResearchTopic(client.id, text)
    setResearchTopics((arr) => [saved, ...arr])
    return saved
  }

  // Optimistically drop the topic, then delete server-side; restore if it fails.
  const removeResearchTopic = async (id) => {
    const prev = researchTopics
    setResearchTopics((arr) => arr.filter((t) => t.id !== id))
    try {
      await apiDeleteResearchTopic(client.id, id)
    } catch {
      setResearchTopics(prev)
      flash('Could not remove the topic')
    }
  }

  // Rename a topic (edit modal). Persist, then swap the updated row in place.
  const editResearchTopic = async (id, text) => {
    const saved = await apiUpdateResearchTopic(client.id, id, { title: text })
    setResearchTopics((arr) => arr.map((t) => (t.id === id ? saved : t)))
    return saved
  }

  // --- Posts (one row per platform, grouped by batch_id) ----------------------
  const postsReady = posts !== null
  // Write a whole batch (all platform rows) at once. The generate modal calls
  // this with status 'scheduled' to finalize; failures surface to the caller.
  const savePostBatch = (batchId, rows, status) => apiSavePostBatch(client.id, batchId, rows, status)

  // Optimistically drop a post row, then delete server-side; reload on failure.
  const removePost = async (id) => {
    const prev = posts
    setPosts((arr) => (arr || []).filter((p) => p.id !== id))
    try {
      await apiDeletePost(client.id, id)
    } catch {
      setPosts(prev)
      flash('Could not remove the post')
    }
  }

  // Persist edits to a single post, then swap the updated row in place. Throws
  // so the edit modal can surface its own error.
  const updatePost = async (id, patch) => {
    const saved = await apiUpdatePost(client.id, id, patch)
    setPosts((arr) => (arr || []).map((p) => (p.id === id ? saved : p)))
    return saved
  }

  // Ask the AI for 2-3 idea suggestions from a topic. Returns the raw list so
  // the review modal can render + let the user pick one. Throws on failure.
  const suggestResearchIdeas = (id) => apiSuggestResearchIdeas(client.id, id)

  // Mark a topic 'done' once it's produced an idea. Done topics stay visible in
  // the list, so just flip the status in place. Optimistic; restore on failure.
  // Throws so callers can react.
  const markResearchTopicDone = async (id) => {
    const prev = researchTopics
    setResearchTopics((arr) => arr.map((t) => (t.id === id ? { ...t, status: 'done' } : t)))
    try {
      await apiUpdateResearchTopic(client.id, id, { status: 'done' })
    } catch (e) {
      setResearchTopics(prev)
      throw e
    }
  }

  const promoteToIdea = async (text) => {
    try {
      await addIdea({ title: text, note: 'Captured from research.', tags: ['Research'], platforms: ['linkedin'] })
      flash('Sent to Idea Bank')
    } catch (e) {
      flash(e.message || 'Could not save idea')
    }
  }

  // breadcrumb from the active child route's last path segment
  const seg = location.pathname.replace(/\/+$/, '').split('/').slice(3).join('/')

  const ctx = {
    client, researchTopics, researchReady, addResearchTopic, removeResearchTopic, editResearchTopic, suggestResearchIdeas, markResearchTopicDone, ideas, ideasReady, addIdea, updateIdea, removeIdea,
    photos, photosReady, addPhoto, addGeneratedPhoto, removePhoto, removePhotos, reorderPhotos,
    flash, startFromIdea, promoteToIdea,
    wantNewIdea, clearNewIdea,
    posts, postsReady, removePost, updatePost, reloadPosts, savePostBatch,
  }

  return (
    <div className="app">
      <TopNav client={client} crumb={CRUMBS[seg] ?? 'Overview'} />

      <div className="main">
        {/* Sections cross-fade and slide on route change instead of snapping.
            Keyed on the path so switching tabs swaps the whole panel; `.view`
            drops its own CSS entrance animation inside .page-swap so the two
            don't stack. */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={location.pathname}
            className="page-swap"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
          >
            <Outlet context={ctx} />
          </motion.div>
        </AnimatePresence>
      </div>

      {generateIdea && (
        <GeneratePostModal
          client={client}
          idea={generateIdea.idea}
          initialFormatByPlat={generateIdea.formatByPlat}
          initialImagePhotos={generateIdea.imagePhotos}
          autoStart={generateIdea.autoStart}
          photos={photos}
          addPhoto={addPhoto}
          addGeneratedPhoto={addGeneratedPhoto}
          removePhoto={removePhoto}
          savePostBatch={savePostBatch}
          onScheduled={reloadPosts}
          onClose={closeGenerate}
          flash={flash}
        />
      )}

      {toast && <div className="toast"><span className="dot" /> {toast}</div>}
    </div>
  )
}
