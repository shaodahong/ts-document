import {
  Project,
  SourceFile,
  TypeChecker,
  Symbol,
  FunctionDeclaration,
  InterfaceDeclaration,
  TypeAliasDeclaration,
  Node,
  Type,
  ts,
  SyntaxKind,
} from 'ts-morph';
import {
  PropertyType,
  GenerateConfig,
  DefaultTypeMapT,
  TagType,
  FunctionSchema,
  Schema,
  SchemaList,
  InterfaceSchema,
  NestedTypeSchema,
  LinkFormatter,
} from './interface';
import { defaultTypeMap, defaultLinkFormatter } from './default';
import { toSingleLine, escape } from './util';
import { format } from 'prettier';

const dummyProject = new Project({ useInMemoryFileSystem: true });

type DeclarationCanBeParsed = InterfaceDeclaration | TypeAliasDeclaration | FunctionDeclaration;

type ExtractType = {
  name: string;
  type: string;
  isOptional: boolean;
};

const KEYWORDS_TO_SKIP = ['Omit'];

const TAG_NAMES_FOR_DESCRIPTION = ['zh', 'en'];

const internalProject = new Project({
  compilerOptions: {
    jsx: 'react' as any,
  },
});

const propertyRegex = /(\w+)\s{0,}([?]?)\s{0,}:(.*?);?$/s;

// extract pure type
function extractFromPropertyText(text: string): ExtractType | undefined {
  const regexResult = propertyRegex.exec(text);
  if (!regexResult) {
    return;
  }
  const name = regexResult[1];
  const isOptional = regexResult[2] === '?';
  const type = regexResult[3];

  return {
    name,
    isOptional,
    type,
  };
}

// Get key-value pairs from jsDoc of Declarations
function getDeclarationTags(declaration: DeclarationCanBeParsed) {
  const tags: Array<TagType> = [];
  const rawTags = declaration.getJsDocs()[0]?.getTags() || [];
  let title;

  for (const tag of rawTags) {
    const name = tag.getTagName();
    const value = tag.getCommentText() || '';

    if (name === 'title') {
      title = value;
    }

    tags.push({ name, value });
  }

  return {
    title,
    tags,
  };
}

// Get key-value pairs from jsDoc of Symbol
function getSymbolTags(sym: Symbol, strictComment = false): TagType[] {
  const jsDocTags = sym.compilerSymbol.getJsDocTags();
  const tags: TagType[] = jsDocTags.map((tag) => ({
    name: tag.name,
    value: tag.text?.[0].text || '',
  }));

  // Try to extend property description from common comment
  if (!strictComment) {
    const [commonComment] = sym.compilerSymbol.getDocumentationComment(undefined);
    if (commonComment && commonComment.kind === 'text' && commonComment.text) {
      TAG_NAMES_FOR_DESCRIPTION.forEach((tagNameForDescription) => {
        if (!tags.find(({ name }) => name === tagNameForDescription)) {
          tags.push({ name: tagNameForDescription, value: commonComment.text });
        }
      });
    }
  }

  return tags;
}

function getSymbolByType(type: Type) {
  return type.getAliasSymbol() || type.getSymbol();
}

function hasJSDocTitle(
  declaration: Node<ts.Node> | DeclarationCanBeParsed,
  parsedNestedTypeSet: Set<Type>
) {
  const { title } =
    (declaration && 'getJsDocs' in declaration && getDeclarationTags(declaration)) || {};
  if (title) {
    // Type with @title in JSDoc is used to format link but not dumped as nested types onto page
    parsedNestedTypeSet.add(declaration.getType());
    return true;
  }
  return false;
}

// Check whether the type is our target that we want to continue parsing
function isTarget(type: Type, parsedNestedTypeSet: Set<Type>) {
  // Has parsed before
  if (parsedNestedTypeSet.has(type)) {
    return false;
  }
  const declaration: any = getDeclarationBySymbol(getSymbolByType(type));
  if (hasJSDocTitle(declaration, parsedNestedTypeSet)) {
    return false;
  }
  const defPath = declaration?.getSourceFile()?.getFilePath();
  if (
    // Types from node_modules
    defPath &&
    defPath.includes('/node_modules/')
  ) {
    return false;
  }

  return (
    type.isInterface() || type.isEnum() || type.isUnionOrIntersection() || isAliasDeclaration(type)
  );
}

function isAliasDeclaration(type: Type) {
  // No type.isAlias method so do alias declaration check separately
  const aliasSymbol = type.getAliasSymbol();
  if (aliasSymbol) {
    return getDeclarationBySymbol(aliasSymbol)?.getKind() === SyntaxKind.TypeAliasDeclaration;
  }
  return false;
}

function getDeclarationBySymbol(symbol?: Symbol) {
  return symbol?.getDeclarations()?.[0];
}

function getDeclarationTextBySymbol(symbol?: Symbol) {
  const declaration = getDeclarationBySymbol(symbol);
  return format(declaration?.print() || '', { parser: 'typescript' });
}

/**
 *
 * @param declaration declaration to be parsed
 * @param nestedTypeList list to store the nested types to be displayed on the doc page
 * @param parsedNestedTypes set of parsed nested types to avoid infinite loop
 * @returns
 */
function dumpNestedTypes(
  declaration: Node<ts.Node> | undefined,
  nestedTypeList: SchemaList,
  parsedNestedTypes: Set<Type>
) {
  if (declaration == null) {
    return;
  }
  if (hasJSDocTitle(declaration, parsedNestedTypes)) {
    return;
  }
  declaration.forEachDescendant((descendant) => {
    const typeOfIdentifier = descendant.getType();
    const symbolOfIdentifier = getSymbolByType(typeOfIdentifier);
    const title = symbolOfIdentifier?.getName();
    if (
      // Only interested in type nodes that has title and matches our target check
      !Node.isTypeNode(descendant) ||
      !title ||
      KEYWORDS_TO_SKIP.includes(title) ||
      !isTarget(typeOfIdentifier, parsedNestedTypes)
    ) {
      return;
    }
    parsedNestedTypes.add(typeOfIdentifier);
    const schema: NestedTypeSchema = {
      tags: [
        {
          name: 'title',
          value: title,
        },
      ],
      data: getDeclarationTextBySymbol(symbolOfIdentifier),
      isNestedType: true,
    } as NestedTypeSchema;
    nestedTypeList.push({
      title,
      schema,
    });
    if (typeOfIdentifier.isUnionOrIntersection()) {
      const method = typeOfIdentifier.isUnion() ? 'getUnionTypes' : 'getIntersectionTypes';
      // Recursively iterate subTypes
      const subTypes = typeOfIdentifier[method]() || [];
      subTypes.forEach((subType) => {
        const subTypeSymbol = getSymbolByType(subType);
        if (subTypeSymbol && getDeclarationBySymbol(subTypeSymbol)) {
          dumpNestedTypes(getDeclarationBySymbol(subTypeSymbol), nestedTypeList, parsedNestedTypes);
        }
      });
    } else if (typeOfIdentifier.isInterface()) {
      // Recursively iterate children properties
      (getDeclarationBySymbol(symbolOfIdentifier) as InterfaceDeclaration)
        .getProperties()
        .forEach((a) => {
          dumpNestedTypes(getDeclarationBySymbol(a.getSymbol()), nestedTypeList, parsedNestedTypes);
        });
    }
  });
  return nestedTypeList;
}

function getDisplayTypeWithLink(
  originTypeText: string,
  nestedTypeList: SchemaList,
  parsedNestedTypeSet: Set<Type>,
  linkFormatter: LinkFormatter
) {
  const sourceFile = dummyProject.createSourceFile(
    './dummy.ts',
    toSingleLine(escape(originTypeText)),
    {
      overwrite: true,
    }
  );
  sourceFile.transform((traversal) => {
    const node = traversal.visitChildren();

    if (ts.isIdentifier(node)) {
      const nodeTypeText = node.text;
      // Check identifiers in the type against parsed custom type definitions and replace with link info if necessary
      for (const parsedNestedType of parsedNestedTypeSet) {
        const typeName = getSymbolByType(parsedNestedType)?.getName();
        if (!typeName || typeName !== nodeTypeText) {
          continue;
        }
        const matchedNestedType = nestedTypeList.find((item) => item.title === typeName);
        let link;
        if (matchedNestedType) {
          // Type that is available on the current page and doesn't have JSDoc @title
          link = linkFormatter({ typeName });
        } else {
          const declaration: any = getDeclarationBySymbol(getSymbolByType(parsedNestedType));
          const definitionPath = declaration?.getSourceFile()?.getFilePath();
          const { title } = (declaration?.getJsDocs && getDeclarationTags(declaration)) || {};
          // Has @title in JSDoc
          if (title) {
            link = linkFormatter({ typeName, jsDocTitle: title, fullPath: definitionPath });
          }
        }
        // Only convert to link when link is available
        if (link) {
          return ts.factory.createIdentifier(`[${typeName}](${link})`);
        }
      }
    }
    return node;
  });
  return sourceFile.getText();
}

// Get Json schema of interface's property
function getPropertySchema(
  sym: Symbol,
  defaultT: DefaultTypeMapT,
  strictComment = false,
  nestedTypeList: SchemaList,
  parsedNestedTypeSet: Set<Type>,
  linkFormatter: LinkFormatter
): PropertyType | null {
  const name = sym.getName();
  const declaration = sym.getDeclarations()[0];
  const typeText = declaration.getText();
  const extract = extractFromPropertyText(typeText);

  if (!extract) {
    return null;
  }

  const tags = getSymbolTags(sym, strictComment);
  if (tags.find(({ name }) => name && TAG_NAMES_FOR_DESCRIPTION.indexOf(name) > -1)) {
    // Deeply analyze nested types
    dumpNestedTypes(declaration, nestedTypeList, parsedNestedTypeSet);

    const typeWithLink = getDisplayTypeWithLink(
      extract.type,
      nestedTypeList,
      parsedNestedTypeSet,
      linkFormatter
    );

    return {
      name,
      type: typeWithLink,
      isOptional: extract.isOptional,
      tags,
    };
  }

  return defaultT[name]
    ? {
        name,
        isOptional: extract.isOptional,
        ...defaultT[name],
      }
    : null;
}

// Get Json schema of Function
function getFunctionSchema(
  declaration: FunctionDeclaration,
  strictComment = false,
  nestedTypeList: SchemaList,
  parsedNestedTypeSet: Set<Type>,
  linkFormatter: LinkFormatter
): Pick<FunctionSchema, 'params' | 'returns'> {
  return {
    params: declaration.getParameters().map((para) => {
      // Deeply analyze nested types
      dumpNestedTypes(para, nestedTypeList, parsedNestedTypeSet);

      const tags = getSymbolTags(para.getSymbol() as Symbol, strictComment);
      const typeWithLink = getDisplayTypeWithLink(
        para
          .getType()
          .getText()
          .replace(/import\([^)]+\)\./g, ''),
        nestedTypeList,
        parsedNestedTypeSet,
        linkFormatter
      );

      return {
        tags,
        name: para.getName(),
        type: typeWithLink,
        isOptional: para.isOptional(),
        initializerText:
          para.getInitializer()?.getText() ||
          tags.find(({ name }) => name === 'default' || name === 'defaultValue')?.value ||
          null,
      };
    }),
    returns: declaration.getReturnType().getText(),
  };
}

function generateSchema(sourceFile: SourceFile, typeChecker: TypeChecker, config?: GenerateConfig) {
  const interfaces = sourceFile?.getInterfaces() || [];
  const typeAliases = sourceFile?.getTypeAliases() || [];
  const functions = sourceFile?.getFunctions() || [];
  const defaultT = config?.defaultTypeMap || defaultTypeMap;
  const strictComment = !!config?.strictComment;
  const propertySorter = config?.propertySorter;
  const linkFormatter = config?.linkFormatter || defaultLinkFormatter;

  const schemaMap: Record<string, Schema> = {};
  const schemaList: SchemaList = [];
  const nestedTypeList: SchemaList = [];
  const parsedNestedTypeSet = new Set<Type>();

  [...interfaces, ...typeAliases, ...functions]
    .sort((declarationA, declarationB) => {
      return declarationA.getStartLineNumber() - declarationB.getStartLineNumber();
    })
    .forEach((declaration) => {
      const { title, tags } = getDeclarationTags(declaration);
      const dType = declaration.getKindName() as
        | 'InterfaceDeclaration'
        | 'FunctionDeclaration'
        | 'TypeAliasDeclaration';

      if (!title) {
        return;
      }

      let schema: Schema;
      const typeNode =
        dType === 'FunctionDeclaration'
          ? (declaration as FunctionDeclaration)
          : dType === 'TypeAliasDeclaration'
          ? (declaration as TypeAliasDeclaration).getTypeNode()
          : null;

      // Function declaration
      if (
        typeNode &&
        ['FunctionDeclaration', 'FunctionType'].indexOf(typeNode.getKindName()) > -1
      ) {
        schema = {
          tags,
          ...getFunctionSchema(
            typeNode as FunctionDeclaration,
            strictComment,
            nestedTypeList,
            parsedNestedTypeSet,
            linkFormatter
          ),
        };
      }
      // Interface declaration forbid extends
      else if (
        dType === 'InterfaceDeclaration' &&
        !!tags.find(({ name }) => name === 'notExtends')
      ) {
        const data: PropertyType[] = [];
        (declaration as InterfaceDeclaration).getProperties().forEach((a) => {
          const schema = getPropertySchema(
            a.getSymbol() as Symbol,
            defaultT,
            strictComment,
            nestedTypeList,
            parsedNestedTypeSet,
            linkFormatter
          );
          schema && data.push(schema);
        });
        schema = { tags, data };
      } else {
        const data: PropertyType[] = [];
        typeChecker.getPropertiesOfType(declaration.getType()).forEach((a) => {
          const schema = getPropertySchema(
            a,
            defaultT,
            strictComment,
            nestedTypeList,
            parsedNestedTypeSet,
            linkFormatter
          );
          schema && data.push(schema);
        });
        schema = { tags, data };
      }

      if (typeof propertySorter === 'function') {
        (schema as InterfaceSchema).data?.sort(propertySorter);
        (schema as FunctionSchema).params?.sort(propertySorter);
      }

      schemaList.push({ title, schema });
      schemaMap[title] = schema;
    });

  let list = schemaList;
  let map = schemaMap;
  if (nestedTypeList.length > 0) {
    list = [...schemaList, ...nestedTypeList];
    map = {
      ...schemaMap,
      ...nestedTypeList.reduce((result, item) => {
        result[item.title] = item.schema;
        return result;
      }, {}),
    };
  }
  return config?.strictDeclarationOrder ? list : map;
}

function generate(
  file: string,
  config?: GenerateConfig
): Record<string, Schema> | Array<{ title: string; schema: Schema }> | undefined {
  const project = config?.project || internalProject;

  if (config?.sourceFilesPaths) {
    project.addSourceFilesAtPaths(config?.sourceFilesPaths);
  }

  const typeChecker = project.getTypeChecker();
  const sourceFile = project.getSourceFile(file);

  if (!sourceFile) {
    return;
  }

  return generateSchema(sourceFile, typeChecker, config);
}

export default generate;
