import { AirbyteProperty, AirbyteSpec, FieldGroup, FormField } from './types';

/**
 * Sorts form fields according to Airbyte documentation rules:
 * 1. Fields with order property come first (sorted by order value)
 * 2. Fields without order come last (required before optional, then alphabetical by field name)
 */
function sortFieldsByAirbyteRules(fields: FormField[]): FormField[] {
  return fields.sort((a, b) => {
    // 1. Fields with order property come first
    const aHasOrder = a.order !== undefined;
    const bHasOrder = b.order !== undefined;

    if (aHasOrder && bHasOrder) {
      // Both have order - sort by order value
      return a.order! - b.order!;
    }

    if (aHasOrder && !bHasOrder) {
      // A has order, B doesn't - A comes first
      return -1;
    }

    if (!aHasOrder && bHasOrder) {
      // B has order, A doesn't - B comes first
      return 1;
    }

    // Neither has order - sort by required status, then alphabetically by field name
    if (a.required && !b.required) {
      // A is required, B is optional - A comes first
      return -1;
    }

    if (!a.required && b.required) {
      // B is required, A is optional - B comes first
      return 1;
    }

    // Both have same required status - sort alphabetically by field name (last part of path)
    const aFieldName = a.path[a.path.length - 1] || '';
    const bFieldName = b.path[b.path.length - 1] || '';
    return aFieldName.localeCompare(bFieldName);
  });
}

/**
 * Sorts oneOf subfields, grouping by parent value first, then applying Airbyte rules within each group
 */
function sortOneOfSubFields(subFields: FormField[]): FormField[] {
  return subFields.sort((a, b) => {
    // Group by parent value first to keep related fields together
    if (a.parentValue !== b.parentValue) {
      return 0; // Don't change order between different parent values
    }

    // Within the same parent value, apply standard Airbyte sorting rules
    // Reuse the same logic but inline since we can't call the function recursively in sort
    const aHasOrder = a.order !== undefined;
    const bHasOrder = b.order !== undefined;

    if (aHasOrder && bHasOrder) {
      return a.order! - b.order!;
    }

    if (aHasOrder && !bHasOrder) {
      return -1;
    }

    if (!aHasOrder && bHasOrder) {
      return 1;
    }

    if (a.required && !b.required) {
      return -1;
    }

    if (!a.required && b.required) {
      return 1;
    }

    const aFieldName = a.path[a.path.length - 1] || '';
    const bFieldName = b.path[b.path.length - 1] || '';
    return aFieldName.localeCompare(bFieldName);
  });
}

export function parseAirbyteSpec(spec: AirbyteSpec): FieldGroup[] {
  const allFields = parseProperties(spec.properties, [], spec.required || []); // on a parent level (not nested oneOfs)

  if (!spec.groups) {
    // If no groups defined, put all fields in a default group - from airbyte documentation.
    sortFieldsByAirbyteRules(allFields);
    return [
      {
        id: 'default',
        fields: allFields,
      },
    ];
  }

  // Group fields based on spec groups
  return spec.groups.map((group) => ({
    id: group.id,
    title: group.title,
    fields: sortFieldsByAirbyteRules(allFields.filter((field) => field.group === group.id)),
  }));
}

function parseProperties(
  properties: Record<string, AirbyteProperty>, // this is the spec.properties, original specs that we get from backend.
  parentPath: string[] = [],
  required: string[] = []
): FormField[] {
  const fields: FormField[] = [];

  for (const [key, prop] of Object.entries(properties)) {
    // Skip hidden fields : Airbye documentation **Hiding inputs in the UI**
    if (prop.airbyte_hidden) {
      continue;
    }

    const path = [...parentPath, key]; // Field 1: path = ["credentials", "client_id"]
    // Controller name = "credentials.client_id"

    if (prop.oneOf) {
      //eg: as in mongodb: properties.database_config.oneOf
      // Handle oneOf fields (usually dropdowns/radio buttons)
      fields.push(parseOneOfField(key, prop, path, required.includes(key)));
    } else if (prop.type === 'array' && prop.items) {
      // Handle array fields with complex items
      fields.push(parseArrayField(key, prop, path, required.includes(key)));
    } else if (prop.type === 'object' && prop.properties) {
      // so oneOf is also type object. , but here were are checking that it should be oneOf and should have properties. type oneof is object but without properties.

      // Recursively handle nested objects especially for s3 bucket schema.
      const nestedRequired = Array.isArray(prop.required) ? prop.required : [];
      fields.push(...parseProperties(prop.properties, path, nestedRequired));
    } else {
      // Handle basic fields
      fields.push(parseBasicField(key, prop, path, required.includes(key)));
    }
  }

  return fields;
}

function parseOneOfField(
  key: string, // "ssl_mode"
  prop: AirbyteProperty, //  {ssl_mode: {one_of: []}} basically the object taht ssl mode has.
  path: string[], // path = [ "ssl_mode"] and
  isRequired: boolean // false
): FormField {
  const subFields: FormField[] = [];
  const constOptions: { value: any; title: string; description?: string }[] = [];
  let constKey: string | undefined; // Store the const key for this oneOf field

  prop.oneOf?.forEach((option) => {
    // Find the const field that identifies this option.
    // This loops through the oneOf array of objects.
    // Each object has properties. Object.entries converts properties to [key, value] pairs,
    // then finds the property with a 'const' field.
    // Example: [["cluster_type", {type: "string", const: "SELF_MANAGED_REPLICA_SET"}]]
    const constField: any[] | undefined = Object.entries(option.properties).find(
      ([_, p]) => p.const
    ); //returns the first matching value.
    //so const key is unique but const value is different for each option.

    if (constField) {
      //this is array containing key and values as [key, {}].
      const [fieldConstKey, constProp] = constField; //[cluster_type, {type: "string", const: "SELF_MANAGED_REPLICA_SET"}]
      const constValue = constProp.const;

      // Store the const key (it should be the same for all options in a oneOf)
      if (!constKey) {
        constKey = fieldConstKey;
      }

      // Add this option to constOptions because the const values will form the options for the dropdown.
      constOptions.push({
        value: constValue,
        title: option.title || constValue,
        description: option.description,
      });

      // Parse the option's other properties as sub-fields (excluding the const field)
      const optionRequired: string[] = Array.isArray(option.required) ? option.required : [];

      Object.entries(option.properties).forEach(([propKey, propDef]) => {
        // this goes through the properties of the values of the oneOf array. Each value === option.
        // so for postgres mode will already be in the constField.
        // Skip the const field itself
        if (propKey === fieldConstKey) return;

        const subFieldPath = [...path, propKey]; //[ssl_mode.client_key]
        // Handle nested oneOf fields recursively
        let subField: FormField;
        if (propDef.oneOf) {
          // This deep nested in for S3 bucket. Rest sources dont have very deep nested oneOf.
          subField = parseOneOfField(
            propKey,
            propDef,
            subFieldPath,
            optionRequired.includes(propKey)
          );
        } else {
          subField = parseBasicField(
            propKey,
            propDef,
            subFieldPath,
            optionRequired.includes(propKey)
          );
        }

        // Add parent value to identify which option this sub-field belongs to
        subField.parentValue = constValue;

        // Make ID unique by including the parent path and const value
        subField.id = `${path.join('.')}.${constValue}.${propKey}`;

        subFields.push(subField);
      });
    }
  });

  // Sort sub-fields according to Airbyte documentation rules
  sortOneOfSubFields(subFields);

  return {
    id: path.join('.'), // Use full path for unique ID
    type: 'object',
    path,
    title: prop.title || key,
    description: prop.description,
    required: isRequired,
    hidden: prop.airbyte_hidden, // Track hidden fields
    displayType: prop.display_type || 'dropdown', // we create this and it will be dropdown only.
    constOptions, // Store full const option details for oneOf rendering
    constKey, // Store the const key for proper object creation
    subFields,
    order: prop.order, // Don't default to 0 - undefined means no order specified
    group: prop.group,
  };
}

function parseArrayField(
  key: string,
  prop: AirbyteProperty,
  path: string[],
  isRequired: boolean
): FormField {
  // for s3 we calculate subfields too.
  let subFields: FormField[] = [];

  // If array items are objects with properties, parse them
  // this is basically for s3 bucket schema. For postgres we have prop.items.type == string.
  if (prop.items?.type === 'object' && prop.items.properties) {
    const itemRequired = Array.isArray(prop.items.required) ? prop.items.required : [];
    subFields = parseProperties(prop.items.properties, [...path, '0'], itemRequired);

    // Sort sub-fields according to Airbyte documentation rules
    sortFieldsByAirbyteRules(subFields);
  }

  return {
    id: path.join('.'), //we create
    type: 'array',
    path, //we create for form rendering.
    title: prop.title || key,
    description: prop.description,
    required: isRequired, // we calculate this.
    hidden: prop.airbyte_hidden, // Track hidden fields
    default: prop.default || [], //default value is usually is []here, but in string its ""
    itemType: prop.items?.type || 'string',
    subFields,
    order: prop.order, // Don't default to 0 - undefined means no order specified
    group: prop.group,
  };
}

function parseBasicField(
  key: string,
  prop: AirbyteProperty,
  path: string[],
  isRequired: boolean
): FormField {
  return {
    id: path.join('.'), // Use full path for unique ID - we create.
    type: prop.type,
    path, // we create for form rendering.
    title: prop.title || key,
    description: prop.description,
    required: isRequired, // we calculate this.
    secret: prop.airbyte_secret,
    hidden: prop.airbyte_hidden, // Track hidden fields
    default: prop.default,
    examples: prop.examples,
    pattern: prop.pattern,
    patternDescriptor: prop.pattern_descriptor,
    multiline: prop.multiline,
    enum: prop.enum,
    format: prop.format,
    minimum: prop.minimum,
    maximum: prop.maximum,
    alwaysShow: prop.always_show,
    order: prop.order, // Don't default to 0 - undefined means no order specified
    group: prop.group,
  };
}

// id - Generated unique identifier
// path - Array representing field hierarchy, that we can join and use as a controller name.
// parentValue -.
// subFields -
// enumOptions -
