import copy from 'fast-copy'

const UNRESOLVED_LINK = {} // unique object to avoid polyfill bloat using Symbol()

/**
 * Checks if the object has sys.type "Link"
 * @param {Object} object
 * @return {Boolean}
 */
const isLink = (object) => object?.sys?.type === 'Link'

/**
 * Checks if the object has sys.type "ResourceLink"
 * @param {Object} object
 * @return {Boolean}
 */
const isResourceLink = (object) => object?.sys?.type === 'ResourceLink'

/**
 * Creates keys for entityMap
 * @param {Object} sys
 * @param {String} sys.type
 * @param {String} sys.id
 * @param {Object} sys.space
 * @param {Object} sys.space.sys
 * @param {String} sys.space.sys.id
 * @param {Object} sys.environment
 * @param {Object} sys.environment.sys
 * @param {String} sys.environment.sys.id
 * @return {String[]}
 */
const makeEntityMapKeys = (sys) => {
  if (sys.space?.sys && sys.environment?.sys) {
    return [`${sys.type}!${sys.id}`, `${sys.space.sys.id}!${sys.environment.sys.id}!${sys.type}!${sys.id}`]
  }

  return [`${sys.type}!${sys.id}`]
}

/**
 * Looks up in entityMap
 * @param {Map} entityMap
 * @param {Object} linkData
 * @param {String} linkData.entryId
 * @param {String} linkData.linkType
 * @param {String} linkData.spaceId
 * @param {String} linkData.environmentId
 * @return {Object|undefined}
 */
const lookupInEntityMap = (entityMap, linkData) => {
  const { entryId, linkType, spaceId, environmentId } = linkData

  if (spaceId && environmentId) {
    return entityMap.get(`${spaceId}!${environmentId}!${linkType}!${entryId}`)
  }

  return entityMap.get(`${linkType}!${entryId}`)
}

/**
 * Extracts IDs from URN
 * @param {String} urn
 * @return {Object|undefined}
 */
const getIdsFromUrn = (urn) => {
  const regExp = /^(.*):spaces\/([^/]+)(?:\/environments\/([^/]+))?\/entries\/([^/]+)$/

  try {
    const [, , spaceId, environmentId = 'master', entryId] = urn.match(regExp) || []

    if (!spaceId || !entryId) {
      throw new Error('Invalid URN format')
    }

    return { spaceId, environmentId, entryId }
  } catch (error) {
    console.error('Error extracting IDs from URN:', error)
    return undefined
  }
}

/**
 * Resolves a link
 * @param {Map} entityMap
 * @param {Object} link
 * @return {Object|undefined}
 */
const getResolvedLink = (entityMap, link) => {
  const { type, linkType } = link.sys
  if (type === 'ResourceLink') {
    const { urn } = link.sys
    const ids = getIdsFromUrn(urn)

    if (!ids) {
      return UNRESOLVED_LINK
    }

    const { spaceId, environmentId, entryId } = ids
    const extractedLinkType = linkType.split(':')[1]

    return (
      lookupInEntityMap(entityMap, {
        linkType: extractedLinkType,
        entryId,
        spaceId,
        environmentId,
      }) || UNRESOLVED_LINK
    )
  }

  const { id: entryId } = link.sys
  return lookupInEntityMap(entityMap, { linkType, entryId }) || UNRESOLVED_LINK
}

/**
 * Removes unresolvable links from Arrays and Objects
 * @param {Array|Object} input
 * @return {Array|Object}
 */
const cleanUpLinks = (input) => {
  if (Array.isArray(input)) {
    return input.filter((val) => val !== UNRESOLVED_LINK)
  }

  for (const key in input) {
    if (Object.prototype.hasOwnProperty.call(input, key) && input[key] === UNRESOLVED_LINK) {
      delete input[key]
    }
  }

  return input
}

/**
 * Walks and mutates an object
 * @param {*} input
 * @param {Function} predicate
 * @param {Function} mutator
 * @param {Boolean} removeUnresolved
 * @return {*}
 */
const walkMutate = (input, predicate, mutator, removeUnresolved) => {
  if (predicate(input)) {
    return mutator(input)
  }

  if (input && typeof input === 'object') {
    for (const key in input) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        input[key] = walkMutate(input[key], predicate, mutator, removeUnresolved)
      }
    }
    if (removeUnresolved) {
      input = cleanUpLinks(input)
    }
  }
  return input
}

/**
 * Normalizes a link
 * @param {Map} entityMap
 * @param {Object} link
 * @param {Boolean} removeUnresolved
 * @return {Object}
 */
const normalizeLink = (entityMap, link, removeUnresolved) => {
  const resolvedLink = getResolvedLink(entityMap, link)
  if (resolvedLink === UNRESOLVED_LINK) {
    return removeUnresolved ? resolvedLink : link
  }
  return resolvedLink
}

/**
 * Creates an entry object based on the provided entry points
 * @param {Object} item
 * @param {String[]} itemEntryPoints
 * @return {Object}
 */
const makeEntryObject = (item, itemEntryPoints) => {
  if (!Array.isArray(itemEntryPoints)) {
    return item
  }

  return itemEntryPoints.reduce((entryObj, entryPoint) => {
    if (Object.prototype.hasOwnProperty.call(item, entryPoint)) {
      entryObj[entryPoint] = item[entryPoint]
    }
    return entryObj
  }, {})
}

/**
 * Resolves contentful response to normalized form
 * @param {Object} response - Contentful response
 * @param {Object} [options={}]
 * @param {Boolean} [options.removeUnresolved=false] - Remove unresolved links
 * @param {String[]} [options.itemEntryPoints=[]] - Resolve links only in those item properties
 * @return {Object[]}
 */
const resolveResponse = (response, options = {}) => {
  if (!response.items) {
    return []
  }

  const responseClone = copy(response)
  const allIncludes = Object.values(responseClone.includes || []).flat()
  const allEntries = [...responseClone.items, ...allIncludes].filter((entity) => Boolean(entity.sys))

  const entityMap = new Map(
    allEntries.flatMap((entity) => makeEntityMapKeys(entity.sys).map((key) => [key, entity])),
  )

  allEntries.forEach((item) => {
    const entryObject = makeEntryObject(item, options.itemEntryPoints)

    Object.assign(
      item,
      walkMutate(
        entryObject,
        (x) => isLink(x) || isResourceLink(x),
        (link) => normalizeLink(entityMap, link, options.removeUnresolved),
        options.removeUnresolved,
      ),
    )
  })

  return responseClone.items
}

export default resolveResponse
