import { dirname } from './utils/path';
import { Promise } from 'sander';
import { parse } from 'acorn';
import MagicString from 'magic-string';
import Statement from './Statement';
import walk from './ast/walk';
import analyse from './ast/analyse';
import { blank, keys } from './utils/object';
import { first, sequence } from './utils/promise';
import { isImportDeclaration, isExportDeclaration } from './utils/map-helpers';
import getLocation from './utils/getLocation';
import makeLegalIdentifier from './utils/makeLegalIdentifier';

const emptyArrayPromise = Promise.resolve([]);

function deconflict ( name, names ) {
	while ( name in names ) {
		name = `_${name}`;
	}

	return name;
}

export default class Module {
	constructor ({ id, source, bundle }) {
		this.source = source;

		this.bundle = bundle;
		this.id = id;

		// By default, `id` is the filename. Custom resolvers and loaders
		// can change that, but it makes sense to use it for the source filename
		this.magicString = new MagicString( source, {
			filename: id
		});

		this.suggestedNames = blank();
		this.comments = [];

		this.statements = this._parse();

		// imports and exports, indexed by ID
		this.imports = blank();
		this.exports = blank();

		this.exportAlls = blank();

		// array of all-export sources
		this.exportDelegates = [];

		this.canonicalNames = blank();

		this.definitions = blank();
		this.definitionPromises = blank();
		this.modifications = blank();

		this.analyse();
	}

	addExport ( statement ) {
		const node = statement.node;
		const source = node.source && node.source.value;

		// export default function foo () {}
		// export default foo;
		// export default 42;
		if ( node.type === 'ExportDefaultDeclaration' ) {
			const isDeclaration = /Declaration$/.test( node.declaration.type );
			const isAnonymous = /(?:Class|Function)Expression$/.test( node.declaration.type );

			const declaredName = isDeclaration && node.declaration.id.name;
			const identifier = node.declaration.type === 'Identifier' && node.declaration.name;

			this.exports.default = {
				statement,
				name: 'default',
				localName: declaredName || 'default',
				declaredName,
				identifier,
				isDeclaration,
				isAnonymous,
				isModified: false // in case of `export default foo; foo = somethingElse`
			};
		}

		// export { foo, bar, baz }
		// export var foo = 42;
		// export function foo () {}
		else if ( node.type === 'ExportNamedDeclaration' ) {
			if ( node.specifiers.length ) {
				// export { foo, bar, baz }
				node.specifiers.forEach( specifier => {
					const localName = specifier.local.name;
					const exportedName = specifier.exported.name;

					this.exports[ exportedName ] = {
						localName,
						exportedName
					};

					// export { foo } from './foo';
					if ( source ) {
						this.imports[ localName ] = {
							source,
							localName,
							name: localName
						};
					}
				});
			}

			else {
				let declaration = node.declaration;

				let name;

				if ( declaration.type === 'VariableDeclaration' ) {
					// export var foo = 42
					name = declaration.declarations[0].id.name;
				} else {
					// export function foo () {}
					name = declaration.id.name;
				}

				this.exports[ name ] = {
					statement,
					localName: name,
					expression: declaration
				};
			}
		}

		// Store `export * from '...'` statements in an array of delegates.
		// When an unknown import is encountered, we see if one of them can satisfy it.
		else {
			this.exportDelegates.push({
				statement,
				source
			});
		}
	}

	addImport ( statement ) {
		const node = statement.node;
		const source = node.source.value;

		node.specifiers.forEach( specifier => {
			const isDefault = specifier.type === 'ImportDefaultSpecifier';
			const isNamespace = specifier.type === 'ImportNamespaceSpecifier';

			const localName = specifier.local.name;
			const name = isDefault ? 'default' : isNamespace ? '*' : specifier.imported.name;

			if ( this.imports[ localName ] ) {
				const err = new Error( `Duplicated import '${localName}'` );
				err.file = this.id;
				err.loc = getLocation( this.source, specifier.start );
				throw err;
			}

			this.imports[ localName ] = {
				source,
				name,
				localName
			};
		});
	}

	analyse () {
		// discover this module's imports and exports
		this.statements.forEach( statement => {
			if ( isImportDeclaration( statement ) ) this.addImport( statement );
			else if ( isExportDeclaration( statement ) ) this.addExport( statement );
		});

		analyse( this.magicString, this );

		// consolidate names that are defined/modified in this module
		this.statements.forEach( statement => {
			keys( statement.defines ).forEach( name => {
				this.definitions[ name ] = statement;
			});

			keys( statement.modifies ).forEach( name => {
				( this.modifications[ name ] || ( this.modifications[ name ] = [] ) ).push( statement );
			});
		});

		// if names are referenced that are neither defined nor imported
		// in this module, we assume that they're globals
		this.statements.forEach( statement => {
			keys( statement.dependsOn ).forEach( name => {
				if ( !this.definitions[ name ] && !this.imports[ name ] ) {
					this.bundle.assumedGlobals[ name ] = true;
				}
			});
		});
	}

	consolidateDependencies () {
		let strongDependencies = blank();

		this.statements.forEach( statement => {
			if ( statement.isImportDeclaration && !statement.node.specifiers.length && !statement.module.isExternal ) {
				// include module for its side-effects
				strongDependencies[ statement.module.id ] = statement.module; // TODO is this right? `statement.module` should be `this`, surely?
			}

			keys( statement.stronglyDependsOn ).forEach( name => {
				if ( statement.defines[ name ] ) return;

				const exportAllDeclaration = this.exportAlls[ name ];

				if ( exportAllDeclaration && exportAllDeclaration.module && !exportAllDeclaration.module.isExternal ) {
					strongDependencies[ exportAllDeclaration.module.id ] = exportAllDeclaration.module;
					return;
				}

				const importDeclaration = this.imports[ name ];

				if ( importDeclaration && importDeclaration.module && !importDeclaration.module.isExternal ) {
					strongDependencies[ importDeclaration.module.id ] = importDeclaration.module;
				}
			});
		});

		let weakDependencies = blank();

		this.statements.forEach( statement => {
			keys( statement.dependsOn ).forEach( name => {
				if ( statement.defines[ name ] ) return;

				const importDeclaration = this.imports[ name ];

				if ( importDeclaration && importDeclaration.module && !importDeclaration.module.isExternal ) {
					weakDependencies[ importDeclaration.module.id ] = importDeclaration.module;
				}
			});
		});

		return { strongDependencies, weakDependencies };
	}

	findDefiningStatement ( name ) {
		if ( this.definitions[ name ] ) return this.definitions[ name ];

		// TODO what about `default`/`*`?

		const importDeclaration = this.imports[ name ];
		if ( !importDeclaration ) return null;

		return Promise.resolve( importDeclaration.module || this.bundle.fetchModule( importDeclaration.source, this.id ) )
			.then( module => {
				importDeclaration.module = module;
				return module.findDefiningStatement( name );
			});
	}

	findDeclaration ( localName ) {
		const importDeclaration = this.imports[ localName ];

		// name was defined by another module
		if ( importDeclaration ) {
			const module = importDeclaration.module;

			if ( module.isExternal ) return null;

			const exportDeclaration = module.exports[ importDeclaration.name ];
			return module.findDeclaration( exportDeclaration.localName );
		}

		// name was defined by this module, if any
		let i = this.statements.length;
		while ( i-- ) {
			const declaration = this.statements[i].scope.declarations[ localName ];
			if ( declaration ) {
				return declaration;
			}
		}

		return null;
	}

	getCanonicalName ( localName ) {
		// Special case
		if ( localName === 'default' && ( this.exports.default.isModified || !this.suggestedNames.default ) ) {
			let canonicalName = makeLegalIdentifier( this.id.replace( dirname( this.bundle.entryModule.id ) + '/', '' ).replace( /\.js$/, '' ) );
			return deconflict( canonicalName, this.definitions );
		}

		if ( this.suggestedNames[ localName ] ) {
			localName = this.suggestedNames[ localName ];
		}

		if ( !this.canonicalNames[ localName ] ) {
			let canonicalName;

			if ( this.imports[ localName ] ) {
				const importDeclaration = this.imports[ localName ];
				const module = importDeclaration.module;

				if ( importDeclaration.name === '*' ) {
					canonicalName = module.suggestedNames[ '*' ];
				} else {
					let exporterLocalName;

					if ( module.isExternal ) {
						exporterLocalName = importDeclaration.name;
					} else {
						const exportDeclaration = module.exports[ importDeclaration.name ];

						// The export declaration of the particular name is known.
						if (exportDeclaration) {
							exporterLocalName = exportDeclaration.localName;
						} else { // export * from '...'
							exporterLocalName = importDeclaration.name;
						}
					}

					canonicalName = module.getCanonicalName( exporterLocalName );
				}
			}

			else {
				canonicalName = localName;
			}

			this.canonicalNames[ localName ] = canonicalName;
		}

		return this.canonicalNames[ localName ];
	}

	mark ( name ) {
		// shortcut cycles. TODO this won't work everywhere...
		if ( this.definitionPromises[ name ] ) {
			return emptyArrayPromise;
		}

		let promise;

		// The definition for this name is in a different module
		if ( this.imports[ name ] ) {
			const importDeclaration = this.imports[ name ];

			promise = this.bundle.fetchModule( importDeclaration.source, this.id )
				.then( module => {
					importDeclaration.module = module;

					// suggest names. TODO should this apply to non default/* imports?
					if ( importDeclaration.name === 'default' ) {
						// TODO this seems ropey
						const localName = importDeclaration.localName;
						let suggestion = this.suggestedNames[ localName ] || localName;

						// special case - the module has its own import by this name
						while ( !module.isExternal && module.imports[ suggestion ] ) {
							suggestion = `_${suggestion}`;
						}

						module.suggestName( 'default', suggestion );
					} else if ( importDeclaration.name === '*' ) {
						const localName = importDeclaration.localName;
						const suggestion = this.suggestedNames[ localName ] || localName;
						module.suggestName( '*', suggestion );
						module.suggestName( 'default', `${suggestion}__default` );
					}

					if ( module.isExternal ) {
						if ( importDeclaration.name === 'default' ) {
							module.needsDefault = true;
						} else {
							module.needsNamed = true;
						}

						module.importedByBundle.push( importDeclaration );
						return emptyArrayPromise;
					}

					if ( importDeclaration.name === '*' ) {
						// we need to create an internal namespace
						if ( !~this.bundle.internalNamespaceModules.indexOf( module ) ) {
							this.bundle.internalNamespaceModules.push( module );
						}

						return module.markAllStatements();
					}

					const exportDeclaration = module.exports[ importDeclaration.name ];

					if ( !exportDeclaration ) {
						const noExport = new Error( `Module ${module.id} does not export ${importDeclaration.name} (imported by ${this.id})` );

						// See if there exists an export delegate that defines `name`.
						return first( module.exportDelegates, noExport, declaration => {
							return module.bundle.fetchModule( declaration.source, module.id ).then( submodule => {
								declaration.module = submodule;

								return submodule.mark( name ).then( result => {
									if ( !result.length ) throw noExport;

									// It's found! This module exports `name` through declaration.
									// It is however not imported into this scope.
									module.exportAlls[ name ] = declaration;

									declaration.statement.dependsOn[ name ] =
									declaration.statement.stronglyDependsOn[ name ] = result;

									return result;
								});
							});
						});
					}

					exportDeclaration.isUsed = true;
					return module.mark( exportDeclaration.localName );
				});
		}

		// The definition is in this module
		else if ( name === 'default' && this.exports.default.isDeclaration ) {
			// We have something like `export default foo` - so we just start again,
			// searching for `foo` instead of default
			promise = this.mark( this.exports.default.name );
		}

		else {
			let statement;

			statement = name === 'default' ? this.exports.default.statement : this.definitions[ name ];
			promise = statement && !statement.isIncluded ? statement.mark() : emptyArrayPromise;

			// Special case - `export default foo; foo += 1` - need to be
			// vigilant about maintaining the correct order of the export
			// declaration. Otherwise, the export declaration will always
			// go at the end of the expansion, because the expansion of
			// `foo` will include statements *after* the declaration
			if ( name === 'default' && this.exports.default.identifier && this.exports.default.isModified ) {
				const defaultExportStatement = this.exports.default.statement;
				promise = promise.then( statements => {
					// remove the default export statement...
					// TODO could this be statements.pop()?
					statements.splice( statements.indexOf( defaultExportStatement ), 1 );

					let i = statements.length;
					let inserted = false;

					while ( i-- ) {
						if ( statements[i].module === this && statements[i].index < defaultExportStatement.index ) {
							statements.splice( i + 1, 0, defaultExportStatement );
							inserted = true;
							break;
						}
					}

					if ( !inserted ) statements.push( statement );
					return statements;
				});
			}
		}

		this.definitionPromises[ name ] = promise || emptyArrayPromise;
		return this.definitionPromises[ name ];
	}

	markAllStatements ( isEntryModule ) {
		return sequence( this.statements, statement => {
			if ( statement.isIncluded ) return; // TODO can this happen? probably not...

			// skip import declarations...
			if ( statement.isImportDeclaration ) {
				// ...unless they're empty, in which case assume we're importing them for the side-effects
				// THIS IS NOT FOOLPROOF. Probably need /*rollup: include */ or similar
				if ( !statement.node.specifiers.length ) {
					return this.bundle.fetchModule( statement.node.source.value, this.id )
						.then( module => {
							statement.module = module;
							if ( module.isExternal ) {
								return;
							}
							return module.markAllStatements();
						});
				}

				return;
			}

			// skip `export { foo, bar, baz }`...
			if ( statement.node.type === 'ExportNamedDeclaration' && statement.node.specifiers.length ) {
				// ...but ensure they are defined, if this is the entry module
				if ( isEntryModule ) {
					return statement.mark();
				}

				return;
			}

			// include everything else
			return statement.mark();
		});
	}

	// TODO rename this to parse, once https://github.com/rollup/rollup/issues/42 is fixed
	_parse () {
		// Try to extract a list of top-level statements/declarations. If
		// the parse fails, attach file info and abort
		let ast;

		try {
			ast = parse( this.source, {
				ecmaVersion: 6,
				sourceType: 'module',
				onComment: ( block, text, start, end ) => this.comments.push({ block, text, start, end })
			});
		} catch ( err ) {
			err.code = 'PARSE_ERROR';
			err.file = this.id; // see above - not necessarily true, but true enough
			throw err;
		}

		walk( ast, {
			enter: node => {
				this.magicString.addSourcemapLocation( node.start );
				this.magicString.addSourcemapLocation( node.end );
			}
		});

		let statements = [];

		ast.body.map( node => {
			// special case - top-level var declarations with multiple declarators
			// should be split up. Otherwise, we may end up including code we
			// don't need, just because an unwanted declarator is included
			if ( node.type === 'VariableDeclaration' && node.declarations.length > 1 ) {
				node.declarations.forEach( declarator => {
					const magicString = this.magicString.snip( declarator.start, declarator.end ).trim();
					magicString.prepend( `${node.kind} ` ).append( ';' );

					const syntheticNode = {
						type: 'VariableDeclaration',
						kind: node.kind,
						start: node.start,
						end: node.end,
						declarations: [ declarator ]
					};

					const statement = new Statement( syntheticNode, magicString, this, statements.length );
					statements.push( statement );
				});
			}

			else {
				const magicString = this.magicString.snip( node.start, node.end ).trim();
				const statement = new Statement( node, magicString, this, statements.length );

				statements.push( statement );
			}
		});

		return statements;
	}

	rename ( name, replacement ) {
		this.canonicalNames[ name ] = replacement;
	}

	suggestName ( defaultOrBatch, suggestion ) {
		// deconflict anonymous default exports with this module's definitions
		const shouldDeconflict = this.exports.default && this.exports.default.isAnonymous;

		if ( shouldDeconflict ) suggestion = deconflict( suggestion, this.definitions );

		if ( !this.suggestedNames[ defaultOrBatch ] ) {
			this.suggestedNames[ defaultOrBatch ] = makeLegalIdentifier( suggestion );
		}
	}
}
